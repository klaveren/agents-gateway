import { offers, targetFor } from '@domain/Agent.Policy'
import { handoffText } from '@domain/Handoff.Policy'
import { resolveSessionMode } from '@domain/Session.Policy'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  AdapterNotFoundError,
  ModelDisabledError,
  NoAgentAvailableError,
  AgentAdminOnlyError,
  SubagentOnlyError,
  AgentNotFoundError,
  AgentUnavailableError,
  AgentWithoutModelError,
  InvalidSessionChangeError,
  ProviderNotOfferedError,
  ProviderUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
} from '@domain/errors/Domain.Error'
import { REASONING_LEVELS } from '@domain/Reasoning.Levels'
import { isSubscription, lanesOf } from '@domain/Subscription.Policy'
import { DEFAULT_SETTINGS, IAgentSettings } from '@domain/models/Settings.Model'
import { IAgentDirectory } from '@domain/ports/AgentRepository.Port'
import { IProviderDirectory } from '@domain/ports/ProviderRepository.Port'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { READ_DOC_TOOL } from '@domain/models/ProjectDoc.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { caller } from '@infra/mcp/Caller.Identity'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider, ISessionChange } from '@domain/ports/AgentProvider.Port'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'

/** Chave do mapa de adapters: cada provider tem uma implementação por lane. */
export function adapterKey(provider: EProvider, mode: EMode): string {
  return `${provider}:${mode}`
}

export class AgentProvider implements IAgentProvider {
  /** As sessões abertas por administrador provado — é o que a filha de uma delegação herda. */
  private readonly adminSessions = new Set<string>()

  constructor(
    private readonly adapters: Map<string, IAgentAdapter>,
    private readonly sessions: SessionStore,

    /**
     * As configurações de operação vivem AQUI, na camada agnóstica.
     *
     * ⚖️ Nem no adapter, nem no controller. O adapter não pode ter opinião sobre quem atende ou com
     * qual modelo — se tivesse, cada um teria a sua, que foi exatamente o que aconteceu com a
     * credencial. O controller é transporte: colocar regra ali a tornaria invisível para quem chama
     * o provider por outro caminho.
     *
     * Opcional para o teste montar o provider sem infraestrutura; ausente, valem os padrões.
     */
    private readonly settings: ISettingsRepository | undefined,

    /** De onde vêm os agentes: o catálogo do banco (ver `makeAgents`). Sem padrão: o seed não é fonte. */
    private readonly agents: IAgentDirectory,

    /**
     * Os providers configurados: o agente aponta para um id, e é o PROTOCOLO dele que escolhe o adapter
     * (um `openrouter` que fala OpenAI vai para os adapters da OpenAI). Ausente, só os oficiais.
     */
    private readonly providers?: IProviderDirectory,

    /**
     * As rules e os documentos do ambiente (ver `GuidanceService`): o texto que vai no system prompt da conversa
     * e se ela tem documento para o `read_doc`. Ausente = sem nada disso.
     */
    private readonly guidance?: { environmentFor(projectId?: string): string | undefined; hasDocs(projectId?: string): boolean },
  ) {
    /**
     * Uma leitura no boot, e depois só quando muda.
     *
     * ⚖️ A ALTERNATIVA ERA LER A CADA SESSÃO. Com cache curto isso funciona, mas põe um `await` de
     * rede no caminho de toda conversa para responder uma pergunta que quase nunca muda — e ainda
     * faz a alteração demorar até o cache expirar. Aqui ela vale no instante em que é salva.
     *
     * `void`: o boot não espera pelo banco. Até a primeira leitura chegar valem os padrões, que é o
     * comportamento certo de um serviço que não pode deixar de subir por causa disso.
     */
    void this.settings?.read().then((stored) => {
      this.current = stored
    })
    this.settings?.subscribe((stored) => {
      this.current = stored
    })
  }

  /** A cópia viva das configurações. Vazia até a primeira leitura — e aí valem os padrões. */
  private current?: IAgentSettings

  async createSession(input: ICreateSessionInput): Promise<IAgentSession> {
    /**
     * A cópia viva quando existe; senão, uma leitura; senão, o default.
     *
     * ⚠️ O `??` do meio não é zelo: entre o boot e a primeira leitura voltar há uma janela em que
     * `current` está vazia, e cair direto nos padrões faria uma sessão dessa janela ser decidida por
     * uma audiência que não é a configurada.
     */
    const settings = this.current ?? (await this.settings?.read()) ?? DEFAULT_SETTINGS

    /**
     * ⛔ `off` fecha para TODOS, e por isso vale aqui, na camada que qualquer caminho atravessa.
     * Fechar impede SESSÃO NOVA, e só: conversa em andamento termina o turno — matá-la no meio
     * deixaria a pessoa com meia resposta e registraria um erro que não foi erro.
     *
     * ⚖️ `restricted` e `all` dependem de QUEM chama e de a identidade ter sido PROVADA, e o provider
     * só enxerga a identidade afirmada do `caller()`. Essa decisão mora no controller (ver
     * `Agent.Controller.createSession`), que resolve a prova antes. Quem abrir sessão por outro
     * caminho que não o HTTP precisa decidir a audiência por si.
     */
    if (settings.audience === 'off') throw new AgentUnavailableError()

    // Corpo → configuração → padrão do registry. O corpo só vence quando alguém escolheu de propósito.
    const agent = this.getAgent(input.agentId || settings.agentId)
    const choice = this.chooseTarget(agent, input, settings)
    const protocol = this.protocolOf(choice.provider)
    const mode = resolveSessionMode(agent, input, lanesOf(protocol))
    // A filha de uma delegação vale o que a mãe vale: admin só se a mãe foi aberta por admin.
    const admin = !!input.adminAccess || (!!input.delegated && !!input.parentSessionId && this.adminSessions.has(input.parentSessionId))
    // ⛔ Só admin quando QUEM CRIOU o agente marcou — nunca inferido do provider ou das ferramentas.
    if (agent.adminOnly && !admin) throw new AgentAdminOnlyError(agent.id)
    // ⛔ Subagente: só pela delegação. Aqui, e não na tela, porque é por aqui que todo caminho passa.
    if (agent.role === 'subagent' && !input.delegated) throw new SubagentOnlyError(agent.id)

    const { adminAccess: _access, delegated: _delegated, parentSessionId: _parent, environment: _environment, ...rest } = input
    // ⚖️ O projeto da CONVERSA (o controller o carimba), não o do agente: o Atlas no XPTO recebe as do XPTO.
    const environment = this.guidance?.environmentFor(projectOf(input.metadata))
    const created = await this.getAdapter(protocol, mode).createSession(this.withDocs(agent, projectOf(input.metadata)), {
      ...rest,
      ...(environment ? { environment } : {}),
      agentId: agent.id,
      provider: choice.provider,
      model: choice.model,
      mode,
    })
    if (admin) {
      this.adminSessions.add(created.id)
      // Sessão que o store já despejou não precisa mais da marca.
      if (this.adminSessions.size > 1000) for (const id of this.adminSessions) if (!this.sessions.get(id)) this.adminSessions.delete(id)
    }
    return created
  }

  /**
   * O store sabe de que agente e de que lane é a sessão, então o chamador só precisa do id.
   * Antes o `agentId` viajava no path da requisição e nada garantia que ele batia com a
   * sessão — dava para pedir o agente errado e receber um "Session not found" sem sentido.
   */
  async *sendMessage(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const record = this.requireSession(sessionId)
    const conversationProject = projectOf(record.metadata)
    const agent = this.withDocs(this.getAgent(record.agentId), conversationProject)
    // ⛔ O modelo da conversa foi desativado (ou sumiu do provider) depois que ela começou: erro claro, em
    // vez de seguir usando um modelo que quem administra tirou. `agent.models` já vem só com os utilizáveis.
    if (record.model && !offers(agent, record.provider, record.model)) throw new ModelDisabledError(record.provider, record.model)
    const adapter = this.getAdapter(record.protocol, record.mode)
    // Acabou de trocar de provider: a transcrição vai antes da mensagem, só para o modelo — o turno
    // gravado continua o que a pessoa escreveu (quem grava é o `SendMessageUseCase`, com o input dele).
    const handoff = record.handoff
    const sent = handoff ? { ...input, text: `${handoff}\n\n${input.text}` } : input
    const turn = { text: '', tools: [] as string[], by: `${record.provider} · ${record.model}`, completed: false }

    record.status = 'running'
    record.turns += 1

    try {
      /**
       * A credencial de quem chamou, resolvida AQUI e em nenhum outro lugar.
       *
       * ⚖️ O provider é a camada agnóstica: é dele a decisão do que vale para esta chamada, e os
       * adapters só recebem. Enquanto cada adapter resolvia por conta própria, uns resolviam e
       * outros não — e os que não resolviam falavam com o MCP sem identidade, o que aparece como
       * "não consegui consultar" e parece problema do provider.
       */
      const context: IExecutionContext = {
        token: caller()?.token,
        sessionId,
        agentId: record.agentId,
        ...(agent.projectId ? { projectId: agent.projectId } : {}),
        ...(conversationProject ? { conversationProjectId: conversationProject } : {}),
      }

      for await (const event of adapter.sendMessage(agent, sessionId, sent, context)) {
        // Somar o usage aqui vale para as seis implementações de uma vez.
        if (event.type === 'usage') this.sessions.addUsage(record, event.payload)
        else if (event.type === 'text.delta') turn.text += event.payload.text
        else if (event.type === 'tool.started') turn.tools.push(event.payload.tool)
        else if (event.type === 'message.completed') turn.completed = true
        yield event
      }
    } finally {
      record.status = 'idle'
      // ⚖️ O turno entra na transcrição mesmo interrompido (o que saiu, saiu).
      if (turn.text || turn.tools.length) {
        record.transcript = [...(record.transcript ?? []), { request: input.text, files: input.files?.map((file) => file.name), text: turn.text, tools: turn.tools, by: turn.by }]
      }
      // O repasse só se dá por entregue quando o provider novo CONCLUIU um turno. Falhou antes: o estado
      // nativo é zerado de novo e o próximo turno leva a transcrição de agora — com o que falhou dentro, e
      // sem o risco de o SDK já ter guardado metade do repasse e recebê-lo duas vezes.
      if (handoff && record.handoff === handoff) {
        if (turn.completed) record.handoff = undefined
        else {
          record.native = undefined
          record.handoff = handoffText(record.transcript ?? [])
        }
      }
    }
  }

  /**
   * O agente com o `read_doc` quando a conversa tem documento no índice: o prompt manda ler, então a
   * ferramenta vem junto, sem ninguém ter de escolhê-la no cadastro do agente.
   */
  private withDocs(agent: IAgent, projectId: string | undefined): IAgent {
    if (!this.guidance?.hasDocs(projectId) || agent.allowedTools.includes(READ_DOC_TOOL)) return agent
    return { ...agent, allowedTools: [...agent.allowedTools, READ_DOC_TOOL] }
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId)
    return this.getAdapter(record.protocol, record.mode).cancel(sessionId)
  }

  /** Encerrar inclui abortar o que estiver em curso: quem faz as duas coisas é o store. */
  async dispose(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) throw new SessionNotFoundError(sessionId)
  }

  describe(sessionId: string): ISession {
    return toSession(this.requireSession(sessionId))
  }

  list(): ISession[] {
    return this.sessions.list().map(toSession)
  }

  /**
   * Troca o modelo, o raciocínio e/ou o PROVIDER de uma sessão viva.
   *
   * Mesmo provider: os adapters leem modelo e raciocínio do registro a cada turno, então basta mudar o
   * registro — o histórico segue o mesmo.
   *
   * Outro provider: o histórico do anterior mora no SDK dele, e o novo não o lê. O estado nativo é
   * zerado (cada adapter recomeça o seu sozinho, ver `nativeOf`) e o próximo turno leva a transcrição
   * (`Handoff.Policy`): o que foi pedido, respondido e que ferramentas rodaram.
   *
   * ⛔ Só provider e modelo que o agente oferece AGORA (os ativados no catálogo, que já vêm filtrados).
   * ⛔ O provider novo precisa estar ligado, com chave, e rodar a lane da sessão (sessão chat não vai para
   * assinatura, que só tem a lane agent). Quem pode conversar já foi decidido na criação (`adminOnly`).
   * ⛔ Nunca no meio de um turno: metade da resposta sairia de um modelo e o custo de outro.
   */
  reconfigure(sessionId: string, change: ISessionChange): ISession {
    const record = this.requireSession(sessionId)
    if (record.status === 'running') throw new SessionBusyError(sessionId)

    const agent = this.getAgent(record.agentId)
    const provider = change.provider ?? record.provider
    const switching = provider !== record.provider
    const target = agent.providers.find((candidate) => candidate.provider === provider)
    if (!target) throw new ProviderNotOfferedError(agent.id, provider)

    const model = change.model ?? (switching ? target.models[0] : record.model)
    const issues: Array<{ field: string; message: string }> = []
    if (!model || ((change.model !== undefined || switching) && !target.models.includes(model)))
      issues.push({ field: 'model', message: `not offered by ${agent.id} on ${provider}: ${model ?? '(none)'}` })

    const protocol = switching ? this.protocolOf(provider) : record.protocol
    if (switching) {
      if (!lanesOf(protocol).includes(record.mode)) issues.push({ field: 'provider', message: `${provider} does not run the ${record.mode} lane` })
      if (!isSubscription(protocol) && this.providers && !this.providers.connection(provider)?.key) issues.push({ field: 'provider', message: `${provider} has no API key` })
    }

    const levels = REASONING_LEVELS[protocol]
    if (change.reasoning && !levels.includes(change.reasoning))
      issues.push({
        field: 'reasoning',
        message: levels.length ? `not a ${protocol} reasoning level: ${change.reasoning}` : `${protocol} has no reasoning control here`,
      })
    if (issues.length) throw new InvalidSessionChangeError(issues)
    if (switching) this.getAdapter(protocol, record.mode)

    record.model = model!
    if (change.reasoning !== undefined) record.reasoning = change.reasoning || undefined
    // O nível que o protocolo novo não aceita cai: o adapter o descartaria em silêncio.
    else if (record.reasoning && !levels.includes(record.reasoning)) record.reasoning = undefined
    if (switching) {
      record.provider = provider
      record.protocol = protocol
      record.native = undefined
      record.handoff = handoffText(record.transcript ?? [])
    }
    return toSession(record)
  }

  /**
   * O provider e o modelo com que a sessão nasce.
   *
   * ⛔ Pedido explícito que o agente não oferece é erro, não troca muda. Sem pedido, valem as
   * configurações e, depois, o padrão do agente — sempre entre os providers que PODEM rodar agora, para
   * um provider desligado no topo da lista não derrubar toda conversa nova.
   */
  private chooseTarget(agent: IAgent, input: ICreateSessionInput, settings: IAgentSettings): { provider: string; model: string } {
    if (input.provider && !agent.providers.some((target) => target.provider === input.provider)) throw new ProviderNotOfferedError(agent.id, input.provider)
    if (input.model && !(input.provider ? offers(agent, input.provider, input.model) : agent.providers.some((target) => target.models.includes(input.model!))))
      throw new ModelDisabledError(input.provider ?? agent.providers[0]?.provider ?? '', input.model)

    const asked = input.provider || input.model
    const runnable = (target: IAgentTarget) => this.agents.isTargetRunnable?.(agent, target) ?? true
    const choice = asked
      ? targetFor(agent, input.provider, input.model)
      : (targetFor(agent, settings.provider, settings.model, runnable) ?? targetFor(agent, settings.provider, settings.model))
    // Os modelos do agente já vêm filtrados pelo catálogo: sem nenhum ativado, não há com o que conversar.
    if (!choice) throw new AgentWithoutModelError(agent.id)
    return choice
  }

  private requireSession(sessionId: string): ISessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new SessionNotFoundError(sessionId)
    return record
  }

  /**
   * Sem `agentId` em lugar nenhum, vale o padrão do diretório: o primeiro que PODE abrir conversa.
   * ⚠️ Antes era o primeiro da lista, que podia estar desligado ou ser subagente.
   */
  private getAgent(agentId?: string): IAgent {
    if (!agentId) {
      const fallback = this.agents.fallback ? this.agents.fallback() : this.agents.list()[0]
      if (!fallback) throw new NoAgentAvailableError()
      return fallback
    }
    const agent = this.agents.get(agentId)
    if (!agent) throw new AgentNotFoundError(agentId)

    return agent
  }

  /**
   * ⛔ Provider desligado ou removido não abre sessão: a mensagem diz onde resolver, em vez de a
   * primeira chamada falhar com um 401 de lugar nenhum.
   */
  private protocolOf(providerId: string): EProvider {
    if (!this.providers) {
      const official = Object.values(EProvider).find((value) => value === providerId)
      if (!official) throw new ProviderUnavailableError(providerId)
      return official
    }

    const provider = this.providers.get(providerId)
    if (!provider?.enabled) throw new ProviderUnavailableError(providerId)
    return provider.protocol
  }

  private getAdapter(provider: EProvider, mode: EMode): IAgentAdapter {
    const adapter = this.adapters.get(adapterKey(provider, mode))
    if (!adapter) throw new AdapterNotFoundError(provider, mode)
    return adapter
  }
}

/**
 * A tradução do registro de infra para a visão do domínio.
 *
 * É trabalho do adapter, e é por isso que ela mora aqui: o `ISessionRecord` carrega
 * `abort`, `native` e o prompt já composto, que são maquinário e não pertencem ao contrato.
 * Note que `lastActivityAt` deixa de ser epoch em milissegundo — aritmética de TTL é
 * problema do store, não do domínio.
 */
function toSession(record: ISessionRecord): ISession {
  return {
    id: record.id,
    agentId: record.agentId,
    provider: record.provider,
    mode: record.mode,
    model: record.model,
    reasoning: record.reasoning,
    language: record.language,
    tools: record.tools,
    status: record.status,
    turns: record.turns,
    usage: record.usage,
    usageByModel: record.usageByModel,
    ...(record.handoff ? { handoff: true } : {}),
    createdAt: record.createdAt,
    lastActivityAt: new Date(record.lastActivityAt),
    metadata: record.metadata,
  }
}

/** O projeto que o controller carimbou na conversa. */
function projectOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.[PROJECT_METADATA_KEY]
  return typeof value === 'string' && value ? value : undefined
}
