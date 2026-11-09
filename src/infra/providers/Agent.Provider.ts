import { freshAnswers, IConversationPanel, PANEL_TOOL, panelMarkdown, panelTurnNote } from '@domain/models/ConversationPanel.Model'
import { reaches, runsUnder } from '@domain/Share.Policy'

/** O painel para o provider: ler e marcar como vistas as respostas que a pessoa deu nele. */
export interface IPanelAccess {
  get(sessionId: string): Promise<IConversationPanel>
  markDelivered?(sessionId: string, ids: readonly string[]): Promise<void>
}
import { DELEGATE_TOOL_NAME } from '@domain/models/Delegation.Model'
import { offers, targetFor } from '@domain/Agent.Policy'
import { conversationNote, IAmbient, IAmbientSecrets } from '@domain/Ambient.Policy'
import { agentFolderAccess, hasTerminal, resolveCapabilities } from '@domain/Capability.Catalog'
import { COMPACT_REQUEST, compactHandoff, shouldCompact } from '@domain/Compaction.Policy'
import { benchKeyOf, DEFAULT_COOLDOWN_MINUTES, fallbackChain, groupOf, IFallbackStep, IModelGroup, nextStep, stepKey, switchesOn, withGroupTargets } from '@domain/Fallback.Policy'
import { HANDOFF_MAX_CHARS, handoffText, ITranscriptTurn } from '@domain/Handoff.Policy'
import type { TProviderFailure } from '@domain/Provider.Failure'
import { INTERJECTION_QUEUE_MAX, interjectionRound } from '@domain/Interjection.Policy'
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
  ConversationNotResumableError,
  InvalidSessionChangeError,
  ProviderNotOfferedError,
  ProviderUnavailableError,
  SessionBusyError,
  InterjectionQueueFullError,
  SessionNotFoundError,
} from '@domain/errors/Domain.Error'
import { REASONING_LEVELS } from '@domain/Reasoning.Levels'
import { isSubscription, lanesOf } from '@domain/Subscription.Policy'
import { DEFAULT_SETTINGS, IAgentSettings } from '@domain/models/Settings.Model'
import { IAgentDirectory } from '@domain/ports/AgentRepository.Port'
import { IProviderDirectory } from '@domain/ports/ProviderRepository.Port'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { READ_DOC_TOOL, SEARCH_DOCS_TOOL } from '@domain/models/ProjectDoc.Model'
import { LEDGER_TOOLS } from '@domain/models/Ledger.Model'
import { SEARCH_RESOURCES_TOOL, USE_RESOURCE_TOOL } from '@domain/models/Resource.Model'
import { PROJECT_METADATA_KEY, REPOSITORY_METADATA_KEY, WORKTREE_METADATA_KEY } from '@domain/Session.Metadata'
import { projectWorkspace, projectWorkspacePath } from '@infra/adapters/support/Subscription.Workspace'
import { currentBranch, resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { IContextWorkFolder, IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { caller } from '@infra/mcp/Caller.Identity'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { INativeSnapshot, IStoredUsage } from '@domain/models/Conversation.Model'
import { ISession, usageKey } from '@domain/models/Session.Model'
import { IAgentProvider, IResumeInput, ISessionChange } from '@domain/ports/AgentProvider.Port'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { LoopGuard } from '@infra/tools/Loop.Guard'
import { ProviderBench } from './Provider.Bench'

/** Chave do mapa de adapters: cada provider tem uma implementação por lane. */
export function adapterKey(provider: EProvider, mode: EMode): string {
  return `${provider}:${mode}`
}

export class AgentProvider implements IAgentProvider {
  /**
   * As sessões abertas por administrador provado, com o escopo que ele administra (o projeto do agente; `null` = o
   * global, do gateway) — é o que a filha de uma delegação herda, e só no MESMO escopo.
   */
  private readonly adminSessions = new Map<string, string | null>()

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
    private readonly guidance?: {
      environmentFor(projectId?: string, agentId?: string): string | undefined
      hasDocs(projectId?: string, agentId?: string): boolean
      hasResources?(agentId?: string): boolean
      hasLedger?(): boolean
    },

    /** Os provedores sem cota agora (ver `Provider.Bench`). Ausente = sem troca de provedor. */
    private readonly bench?: ProviderBench,

    /** A janela de contexto do modelo (`ModelCatalogService.contextOf`): é o que dispara a compactação. Ausente = não compacta sozinho. */
    private readonly contextOf?: (provider: string, model: string) => number | undefined,

    /** O detector de laço (ver `Loop.Guard`): aberto a cada turno, para o turno que repete a mesma chamada. Ausente = sem detector. */
    private readonly loops?: LoopGuard,

    /** O nome de um projeto, para o "## Ambiente" do system prompt (ver `Ambient.Policy`). Ausente = só o id. */
    private readonly projectName?: (projectId: string) => string | undefined,
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
    // ⛔ O agente de um projeto só conversa num OUTRO projeto se foi compartilhado com ele (parou de compartilhar = sem acesso).
    if (!reaches(agent, projectOf(input.metadata))) throw new AgentNotFoundError(agent.id)
    const choice = this.chooseTarget(agent, input, settings)
    const protocol = this.protocolOf(choice.provider)
    const mode = resolveSessionMode(agent, input, lanesOf(protocol))
    // A filha de uma delegação vale o que a mãe vale: admin só se a mãe foi aberta por admin.
    // ⛔ E só no mesmo escopo: o admin de um projeto não herda o agente global (nem o de outro projeto) pela delegação.
    const scope = agent.projectId ?? null
    const admin =
      !!input.adminAccess ||
      (!!input.delegated && !!input.parentSessionId && this.adminSessions.has(input.parentSessionId) && this.adminSessions.get(input.parentSessionId) === scope)
    // ⛔ Só admin quando QUEM CRIOU o agente marcou — nunca inferido do provider ou das ferramentas.
    if (agent.adminOnly && !admin) throw new AgentAdminOnlyError(agent.id)
    // ⛔ Subagente: só pela delegação. Aqui, e não na tela, porque é por aqui que todo caminho passa.
    if (agent.role === 'subagent' && !input.delegated) throw new SubagentOnlyError(agent.id)

    const { adminAccess: _access, delegated: _delegated, parentSessionId: _parent, environment: _environment, ambient: _ambient, ...rest } = input
    // ⚖️ O projeto da CONVERSA (o controller o carimba), não o do agente: o Atlas no XPTO recebe as do XPTO.
    const environment = this.guidance?.environmentFor(projectOf(input.metadata), agent.id)
    const created = await this.getAdapter(protocol, mode).createSession(this.prepare(agent, projectOf(input.metadata), choice.provider, protocol, mode).agent, {
      ...rest,
      ...(environment ? { environment } : {}),
      ambient: this.ambientOf(agent, input.metadata),
      agentId: agent.id,
      provider: choice.provider,
      model: choice.model,
      mode,
    })
    if (admin) {
      this.adminSessions.set(created.id, scope)
      // Sessão que o store já despejou não precisa mais da marca.
      if (this.adminSessions.size > 1000) for (const id of this.adminSessions.keys()) if (!this.sessions.get(id)) this.adminSessions.delete(id)
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
    // ⛔ A conversa antiga de um projeto com um agente que ele já não recebe fica no histórico, mas não continua.
    if (!reaches(this.getAgent(record.agentId), conversationProject)) throw new AgentNotFoundError(record.agentId)
    let { agent, unavailable } = this.prepare(this.getAgent(record.agentId), conversationProject, record.provider, record.protocol, record.mode)
    // ⚖️ O modelo da conversa foi desativado (ou sumiu do provider) depois que ela começou: a conversa SEGUE no modelo que
    // o agente escolheria hoje (o grupo de modelos, as configurações, o padrão), com aviso no turno. Antes era erro, e a
    // conversa retomada por quem orquestra (a esteira) travava sem ninguém para trocar o modelo à mão.
    // `agent.models` já vem só com os utilizáveis. Sem nenhum modelo ativo, o erro de antes.
    let swapped: string | undefined
    if (record.model && !offers(agent, record.provider, record.model)) {
      const before = `${record.provider} · ${record.model}`
      const settings = this.current ?? (await this.settings?.read()) ?? DEFAULT_SETTINGS
      try {
        this.reconfigure(sessionId, this.chooseTarget(this.getAgent(record.agentId), {}, settings))
      } catch {
        throw new ModelDisabledError(record.provider, record.model)
      }
      ;({ agent, unavailable } = this.prepare(this.getAgent(record.agentId), conversationProject, record.provider, record.protocol, record.mode))
      swapped = `O modelo ${before} foi desligado; a conversa segue em ${record.provider} · ${record.model}.`
    }
    let adapter = this.getAdapter(record.protocol, record.mode)
    // Acabou de trocar de provider: a transcrição vai antes da mensagem, só para o modelo — o turno
    // gravado continua o que a pessoa escreveu (quem grava é o `SendMessageUseCase`, com o input dele).
    let handoff = record.handoff
    // O contexto do sistema que não foi na mensagem (ver `SendMessageUseCase.withContext`): volta com o repasse feito
    // no meio do turno, quando o modelo recomeça do zero. O adapter nunca o recebe solto.
    const { context: systemContext, compactOnly, ...asked } = input
    // ⚖️ O PAINEL DA CONVERSA no começo de cada turno (ver `ConversationPanel.Model`): a rota — objetivo, em andamento,
    // fila, perguntas —, e o aviso quando o turno anterior não o atualizou. Só na entrada do modelo, nunca no turno gravado.
    const panelNow = this.panels ? await this.panels.get(record.id).catch(() => undefined) : undefined
    const panelNote = this.panels ? panelTurnNote(panelNow, record.panelSkipped) : ''
    // A resposta que a pessoa deu no painel vai UMA vez: entregue neste turno, sai do próximo aviso.
    const delivered = panelNow ? freshAnswers(panelNow).map((question) => question.id) : []
    if (delivered.length) await this.panels?.markDelivered?.(record.id, delivered).catch(() => undefined)
    const message = panelNote ? { ...asked, text: `${panelNote}\n\n${asked.text}` } : asked
    let panelTouched = false
    // ⚖️ O id da conversa vai UMA VEZ por histórico do modelo: no primeiro turno e quando ele recomeça (repasse, compactação,
    // retomada, troca de provedor). Só na entrada do modelo: a transcrição e o turno gravado ficam com o `input`.
    const note = conversationNote(record.id)
    const opening = (block: string | undefined): IMessageInput => (block ? { ...message, text: [note, block, systemContext, message.text].filter(Boolean).join('\n\n') } : message)
    let sent = handoff || record.turns === 0 ? { ...message, text: [note, handoff, message.text].filter(Boolean).join('\n\n') } : message
    const turn = { text: '', tools: [] as string[], by: `${record.provider} · ${record.model}`, completed: false }
    // ⛔ UM TURNO POR VEZ: o segundo rodaria por cima do primeiro (o cancelar só alcançava o último, e a transcrição e o
    // estado nativo se misturavam). A tela e a API recebem 409 `session_busy`.
    if (record.status === 'running') throw new SessionBusyError(sessionId)
    const workFolder = workFolderOf(record.metadata, conversationProject)

    record.status = 'running'
    this.loops?.open(sessionId)
    record.turns += 1
    // Os passos já tentados neste turno (ver `benchKeyOf`): na cota, o provedor inteiro sai; no erro do modelo, só ele.
    const tried = new Set<string>([stepKey(record)])
    // As mensagens que a pessoa mandou com o turno rodando (ver `Interjection.Policy`): as que entraram, e as que entraram
    // e ainda não saíram como evento (a lane as tira da fila no meio da chamada; o evento sai antes do próximo dela).
    const interjections: string[] = []
    const unannounced: string[] = []
    const take = (): string[] => {
      const texts = record.queued ?? []
      record.queued = undefined
      interjections.push(...texts)
      unannounced.push(...texts)
      return texts
    }
    const announce = (): IAgentEvent[] => unannounced.splice(0).map((text) => ({ type: 'message.injected', sessionId, timestamp: new Date(), payload: { text } }))
    /** Já houve rodada a mais: o `message.started` dela não sai (o turno é um só). */
    let extraRound = false
    const discard = (why: string): IAgentEvent[] => {
      const left = record.queued?.length ?? 0
      record.queued = undefined
      return left ? [{ type: 'warning', sessionId, timestamp: new Date(), payload: { message: `${left} mensagem(ns) que esperavam o turno não entraram: ${why}.` } }] : []
    }

    /** Passa a conversa para o próximo passo da cadeia: o mesmo pedido, com a transcrição e o que o turno já fez. */
    const switchTo = (next: IFallbackStep, partial: boolean): string => {
      const from = `${record.provider} · ${record.model}`
      this.moveTo(record, next)
      const done: ITranscriptTurn[] = partial && (turn.text || turn.tools.length) ? [{ request: '(a mensagem abaixo)', text: turn.text, tools: turn.tools, by: turn.by }] : []
      handoff = handoffText([...(record.transcript ?? []), ...done], HANDOFF_MAX_CHARS, partial ? 'quota' : 'switch')
      record.handoff = handoff
      record.handoffKind = partial ? 'quota' : 'switch'
      sent = opening(handoff)
      turn.by = `${record.provider} · ${record.model}`
      tried.add(stepKey(record))
      ;({ agent, unavailable } = this.prepare(this.getAgent(record.agentId), conversationProject, record.provider, record.protocol, record.mode))
      adapter = this.getAdapter(record.protocol, record.mode)
      return from
    }

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
        ...(workFolder ? { workFolder } : {}),
      }
      // ⛔ As variáveis secretas do turno (ver `ResourceSecret.Model`), para os terminais nativos: já entram na máscara.
      const secretEnv = this.secrets?.envFor(record.agentId, sessionId, conversationProject).env
      if (secretEnv && Object.keys(secretEnv).length) context.secretEnv = secretEnv

      // O passo da conversa ficou de lado em outra conversa (cota, modelo fora): este turno já começa no próximo do grupo.
      if (this.isStepBenched(record)) {
        const next = this.nextFallback(record, tried)
        if (next) {
          const from = switchTo(next, false)
          yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: `${from} está sem cota agora; a conversa segue em ${turn.by}.` } }
        }
      }

      if (swapped) yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: swapped } }

      // O contexto passou do gatilho, ou a compactação foi pedida: o turno começa com o resumo (ver `Compaction.Policy`).
      // Com repasse pendente não: o provedor novo já recomeça só com a transcrição.
      const window = this.contextOf?.(record.provider, record.model)
      if (compactOnly) record.compactNext = true
      const before = record.usage.contextTokens
      let compacted = false
      if (!handoff && !adapter.compactsItself && record.native !== undefined && (record.compactNext || shouldCompact(record.usage.contextTokens, window))) {
        compacted = true
        const share = window && record.usage.contextTokens ? ` (${Math.round((record.usage.contextTokens / window) * 100)}% da janela de ${window} tokens)` : ''
        yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: `Compactando o contexto${share}…` } }
        const summary = yield* this.summarize(record, agent, adapter, context)
        record.compactNext = false
        record.native = undefined
        record.compactSummary = summary
        handoff = summary ? compactHandoff(summary, record.transcript ?? []) : handoffText(record.transcript ?? [], HANDOFF_MAX_CHARS, 'compact')
        // O painel inteiro vai junto: o que foi entregue e decidido não se perde no resumo.
        const panel = this.panels ? await this.panels.get(record.id).catch(() => undefined) : undefined
        if (panel && (panel.goal || panel.items.length || panel.decisions.length)) handoff = `${handoff}\n\n${panelMarkdown(panel)}`
        record.handoff = handoff
        record.handoffKind = 'compact'
        sent = opening(handoff)
        yield {
          type: 'warning',
          sessionId,
          timestamp: new Date(),
          payload: {
            message: summary
              ? 'Contexto compactado: a conversa segue com um resumo e os últimos turnos por extenso.'
              : 'O resumo do contexto falhou: a conversa segue com a transcrição dos turnos mais recentes.',
          },
        }
      }

      // O que o agente tem e não roda neste provedor: avisa no primeiro turno e quando a conversa troca de provedor.
      if (unavailable.length && (record.turns === 1 || handoff))
        yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: `Indisponível em ${record.provider}: ${unavailable.join(', ')}.` } }

      // ⚖️ O TURNO SÓ DE COMPACTAÇÃO acaba aqui: o resumo fica como repasse para a próxima mensagem (o `finally` o mantém,
      // porque este turno não "concluiu" um turno do modelo). O medidor cai para o tamanho do resumo.
      if (compactOnly) {
        record.compactNext = false
        const after = compacted && record.handoff ? Math.ceil(record.handoff.length / 4) : undefined
        if (after !== undefined) record.usage.contextTokens = after
        const text = !compacted
          ? record.native === undefined
            ? 'Nada para compactar agora: o modelo ainda não tem histórico desta conversa (ou ela já recomeça com um resumo).'
            : 'Esta conversa não pode ser compactada aqui.'
          : `Contexto compactado${before ? `: de ~${before.toLocaleString('pt-BR')} para ~${(after ?? 0).toLocaleString('pt-BR')} tokens` : ''}. A próxima mensagem já começa com o resumo.`
        yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text } }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
        return
      }

      for (;;) {
        let exhausted: { message: string; resetsAt?: string; kind: TProviderFailure; next: IFallbackStep } | undefined
        // O fim da rodada fica retido: com mensagem na fila, o turno ainda não acabou.
        let completed: IAgentEvent | undefined
        let stopped = false
        for await (const event of adapter.sendMessage(agent, sessionId, { ...sent, interjections: take }, context)) {
          // ⚖️ A FALHA QUE O GRUPO TROCA (cota, limite, modelo fora…) com um próximo nele: o erro não sai, o turno segue no
          // próximo (ver `Fallback.Policy`). O passo que falhou sai do turno: o provedor inteiro na cota, só o modelo no erro dele.
          const kind = event.type === 'error' ? event.payload.kind : undefined
          if (event.type === 'error' && kind && switchesOn(this.groupFor(record), kind)) {
            tried.add(benchKeyOf(record, kind))
            const next = this.nextFallback(record, tried)
            if (next) {
              exhausted = { message: event.payload.message, ...(event.payload.resetsAt ? { resetsAt: event.payload.resetsAt } : {}), kind, next }
              break
            }
          }
          // ⚖️ A mensagem que entrou junto do resultado de uma ferramenta (o `PostToolUse` do Claude a tira da fila ANTES de o
          // resultado chegar aqui) sai depois dele: na tela, o balão vem depois da ferramenta concluída.
          const toolEnd = event.type === 'tool.result' || event.type === 'tool.error'
          // ⚖️ A DELEGAÇÃO CORTADA PELO CLIENTE DO MODELO não é a conversa cortada: o outro agente segue no gateway, e a
          // resposta dele entra aqui quando chegar (ver `Delegation.Service`). O agente fica sabendo agora, em vez de só
          // ver "interrupted" e refazer o pedido ou desistir.
          if (toolEnd && event.payload.tool === DELEGATE_TOOL_NAME && interruptedCall(event)) {
            ;(record.queued ??= []).push(DELEGATION_CUT_NOTICE)
            console.warn(`[delegação] o cliente do modelo cortou a chamada de ${record.agentId} (${sessionId}); a outra conversa segue`)
          }
          if (!toolEnd) yield* announce()
          if (event.type === 'message.started' && extraRound) continue
          if (event.type === 'message.completed') {
            turn.completed = true
            completed = event
            continue
          }
          if (event.type === 'message.aborted' || event.type === 'error') stopped = true
          // Somar o usage aqui vale para as seis implementações de uma vez.
          if (event.type === 'usage') this.sessions.addUsage(record, event.payload)
          else if (event.type === 'text.delta') turn.text += event.payload.text
          else if (event.type === 'tool.started') turn.tools.push(event.payload.tool)
          if (event.type === 'tool.started') this.loops?.observe(sessionId, { type: 'tool.started', tool: event.payload.tool, args: event.payload.args })
          if (event.type === 'tool.started' && event.payload.tool === PANEL_TOOL) panelTouched = true
          else if (event.type === 'tool.error' || event.type === 'tool.result') this.loops?.observe(sessionId, { type: event.type })
          yield event
          if (toolEnd) yield* announce()
          // ⛔ LAÇO: a mesma chamada repetida (ou erros seguidos) além do limite para o turno (ver `Loop.Policy`).
          const loop = this.loops?.stopReason(sessionId)
          if (loop) {
            await adapter.cancel(sessionId).catch(() => undefined)
            yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: loop } }
            yield* discard('o turno parou')
            yield { type: 'message.aborted', sessionId, timestamp: new Date() }
            return
          }
        }
        if (!exhausted) {
          yield* announce()
          if (stopped || !completed) {
            yield* discard('o turno parou')
            break
          }
          // ⚖️ O modelo terminou com mensagem na fila: mais uma rodada no MESMO turno, com elas como a próxima fala.
          const rest = take()
          if (rest.length) {
            yield* announce()
            sent = { text: interjectionRound(rest) }
            extraRound = true
            continue
          }
          yield completed
          break
        }

        this.benchStep(record, exhausted.kind, exhausted.resetsAt)
        const from = switchTo(exhausted.next, true)
        yield {
          type: 'warning',
          sessionId,
          timestamp: new Date(),
          payload: { message: `${FAILURE_LABEL[exhausted.kind]} em ${from} (${exhausted.message.slice(0, 200)}); a conversa segue em ${turn.by}.` },
        }
        if (unavailable.length) yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message: `Indisponível em ${record.provider}: ${unavailable.join(', ')}.` } }
      }
    } finally {
      // A pessoa falou e o painel não mudou: o próximo turno começa com o aviso (o agente corrige sozinho).
      if (this.panels) record.panelSkipped = !panelTouched && !!asked.text.trim()
      record.status = 'idle'
      record.queued = undefined
      this.loops?.close(sessionId)
      // ⚖️ O turno entra na transcrição mesmo interrompido (o que saiu, saiu).
      if (turn.text || turn.tools.length) {
        record.transcript = [
          ...(record.transcript ?? []),
          {
            request: input.text,
            files: input.files?.map((file) => file.name),
            text: turn.text,
            tools: turn.tools,
            by: turn.by,
            ...(interjections.length ? { interjections } : {}),
          },
        ]
      }
      // O repasse só se dá por entregue quando o provider novo CONCLUIU um turno. Falhou antes: o estado
      // nativo é zerado de novo e o próximo turno leva a transcrição de agora — com o que falhou dentro, e
      // sem o risco de o SDK já ter guardado metade do repasse e recebê-lo duas vezes.
      if (handoff && record.handoff === handoff) {
        if (turn.completed) {
          record.handoff = undefined
          record.compactSummary = undefined
        } else {
          record.native = undefined
          record.handoff =
            record.handoffKind === 'compact' && record.compactSummary
              ? compactHandoff(record.compactSummary, record.transcript ?? [])
              : handoffText(record.transcript ?? [], HANDOFF_MAX_CHARS, record.handoffKind === 'quota' ? 'switch' : record.handoffKind)
        }
      }
    }
  }

  /**
   * A mensagem para o turno que está rodando (ver `Interjection.Policy`): a posição dela na fila, ou nada quando a conversa
   * não está rodando (aí quem chamou manda como um turno normal).
   */
  enqueue(sessionId: string, text: string): number | undefined {
    const record = this.requireSession(sessionId)
    if (record.status !== 'running') return undefined
    const queue = (record.queued ??= [])
    if (queue.length >= INTERJECTION_QUEUE_MAX) throw new InterjectionQueueFullError(sessionId, INTERJECTION_QUEUE_MAX)
    queue.push(text)
    return queue.length
  }

  /**
   * O TURNO OCULTO da compactação: o mesmo adapter, com o histórico inteiro, pede o resumo. Nada dele sai nem é gravado
   * como turno, só o consumo. ⛔ Ferramenta ou erro no meio: desiste, e vale a transcrição recortada. Nas lanes de chat o
   * `return` encerra o gerador antes de a ferramenta rodar; nas de SDK (OpenAI Agents, ADK) ela pode já ter rodado.
   */
  private async *summarize(record: ISessionRecord, agent: IAgent, adapter: IAgentAdapter, context: IExecutionContext): AsyncGenerator<IAgentEvent, string | undefined> {
    let text = ''
    try {
      for await (const event of adapter.sendMessage(agent, record.id, { text: COMPACT_REQUEST }, context)) {
        if (event.type === 'usage') {
          this.sessions.addUsage(record, event.payload)
          yield event
        } else if (event.type === 'text.delta') text += event.payload.text
        else if (event.type === 'tool.started' || event.type === 'error') return undefined
      }
    } catch {
      return undefined
    }
    return text.trim() || undefined
  }

  /**
   * Pede a compactação À MÃO: o próximo turno começa com o resumo, passe ou não do gatilho. ⛔ A lane que compacta sozinha
   * (Codex, Antigravity) recusa: o gateway não mexe no contexto dela.
   */
  requestCompaction(sessionId: string): ISession {
    const record = this.requireSession(sessionId)
    if (this.getAdapter(record.protocol, record.mode).compactsItself)
      throw new InvalidSessionChangeError([{ field: 'session', message: `${record.provider} (${record.mode}) compacts its own context` }])
    record.compactNext = true
    return this.view(record)
  }

  /** O grupo de modelos da conversa: o do agente, senão o padrão (ver `Fallback.Policy`). */
  private groupFor(record: Pick<ISessionRecord, 'agentId'>): IModelGroup | undefined {
    return groupOf(this.agents.get(record.agentId) ?? {}, this.current)
  }

  /** O próximo passo do grupo que pode rodar agora, ou nada (aí o erro sai como sempre). */
  private nextFallback(record: ISessionRecord, tried: ReadonlySet<string>): IFallbackStep | undefined {
    if (!this.bench) return undefined
    const agent = this.getAgent(record.agentId)
    return nextStep(fallbackChain(this.groupFor(record)), tried, (step) => this.canRun(agent, record.mode, step))
  }

  /** O passo está de lado: o provedor inteiro (cota) ou só o modelo (erro dele). */
  private isStepBenched(step: IFallbackStep): boolean {
    return !!this.bench && (this.bench.isBenched(step.provider) || this.bench.isBenched(stepKey(step)))
  }

  /** O passo roda nesta lane, com chave (ou assinatura), fora do banco de reservas e com o provider ligado. */
  private canRun(agent: IAgent, mode: EMode, step: IFallbackStep): boolean {
    if (this.isStepBenched(step)) return false
    try {
      const protocol = this.protocolOf(step.provider)
      if (!lanesOf(protocol).includes(mode) || !this.adapters.has(adapterKey(protocol, mode))) return false
      if (!isSubscription(protocol) && this.providers && !this.providers.connection(step.provider)?.key) return false
      const target = agent.providers.find((candidate) => candidate.provider === step.provider)
      return !!target && (this.agents.isTargetRunnable?.(agent, target) ?? true)
    } catch {
      return false
    }
  }

  /** O passo que falhou fica de lado até voltar (quando o erro diz) ou pelo tempo do grupo: o provedor na cota, o modelo no erro dele. */
  private benchStep(record: ISessionRecord, kind: TProviderFailure, resetsAt: string | undefined): void {
    const back = resetsAt ? Date.parse(resetsAt) : Number.NaN
    const cooldown = (this.groupFor(record)?.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000
    this.bench?.bench(benchKeyOf(record, kind), Number.isFinite(back) && back > Date.now() ? back : Date.now() + cooldown)
  }

  /** A sessão passa para outro provedor e modelo: o estado nativo do anterior fica para trás (ver `reconfigure`). */
  private moveTo(record: ISessionRecord, step: IFallbackStep): void {
    const protocol = this.protocolOf(step.provider)
    record.provider = step.provider
    record.protocol = protocol
    record.model = step.model
    // O nível que o protocolo novo não aceita cai: o adapter o descartaria em silêncio.
    if (record.reasoning && !REASONING_LEVELS[protocol].includes(record.reasoning)) record.reasoning = undefined
    record.native = undefined
  }

  /**
   * Onde a conversa opera, para o "## Ambiente" do system prompt: o diretório pela MESMA regra das lanes — a pasta do
   * repositório ou da worktree (`workFolderOf`), senão a do projeto do agente, senão a pasta vazia da conversa.
   */
  /** A pasta dos arquivos do agente (ver `ResourceFile.Model`), para o "## Ambiente". Ligada na composição. */
  useAgentFiles(dirOf: (agent: IAgent) => string | undefined): void {
    this.agentFiles = dirOf
  }

  /** O painel da conversa (ver `ConversationPanel.Model`): a ferramenta em todo agente, a rota no começo do turno. */
  usePanels(panels: IPanelAccess): void {
    this.panels = panels
  }

  private panels?: IPanelAccess

  /** As variáveis secretas (ver `ResourceSecrets.Service`): o ambiente do turno e os nomes do prompt. Ligadas na composição. */
  useSecrets(secrets: {
    envFor(agentId: string, sessionId: string, conversationProject?: string): { env: Record<string, string> }
    ambientFor(agent: IAgent, conversationProject?: string): IAmbientSecrets | undefined
  }): void {
    this.secrets = secrets
  }

  private secrets?: {
    envFor(agentId: string, sessionId: string, conversationProject?: string): { env: Record<string, string> }
    ambientFor(agent: IAgent, conversationProject?: string): IAmbientSecrets | undefined
  }

  private agentFiles?: (agent: IAgent) => string | undefined

  /** A pasta privada no "## Ambiente", só para o agente que a alcança (Ler, Escrever arquivos ou Terminal). */
  private agentFolderOf(agent: IAgent, conversationProject?: string): { files?: { dir: string; write: boolean } } {
    const dir = this.agentFiles?.(agent)
    const access = agentFolderAccess(agent.allowedTools)
    // ⛔ Agente compartilhado numa conversa de outro projeto: a pasta dele é só leitura.
    return dir && access.read ? { files: { dir, write: access.write && runsUnder(agent, conversationProject) === agent.projectId } } : {}
  }

  private ambientOf(agent: IAgent, metadata: Record<string, unknown> | undefined): IAmbient {
    const projectId = projectOf(metadata) ?? agent.projectId
    // ⛔ Agente compartilhado numa conversa de outro projeto: nada da origem (a pasta, o "é o dele") — como o global.
    const home = runsUnder(agent, projectOf(metadata))
    let folder: IContextWorkFolder | undefined
    try {
      folder = workFolderOf(metadata, projectOf(metadata))
    } catch {
      // A worktree que sumiu falha o turno, com o motivo (ver `workFolderOf`); aqui só não se diz que ela existe.
      folder = undefined
    }
    const name = projectId ? this.projectName?.(projectId) : undefined
    const branch = folder?.repository ? currentBranch(folder) : undefined
    return {
      agentId: agent.id,
      ...(projectId ? { project: { id: projectId, ...(name ? { name } : {}), own: home === projectId } } : {}),
      ...(folder?.repository ? { repository: { name: folder.repository, ...(folder.worktree ? { worktree: folder.worktree } : {}), ...(branch ? { branch } : {}) } } : {}),
      ...(folder ? { directory: folder.dir } : home ? { directory: projectWorkspacePath(home) } : {}),
      ...this.agentFolderOf(agent, projectOf(metadata)),
      ...(hasTerminal(agent.allowedTools) ? { terminal: true } : {}),
      ...(this.secrets?.ambientFor(agent, projectOf(metadata)) ? { secrets: this.secrets.ambientFor(agent, projectOf(metadata))! } : {}),
      ...(this.panels ? { panel: true } : {}),
    }
  }

  /**
   * O agente como o adapter o recebe: com as ferramentas implícitas (`withDocs`) e as CAPACIDADES (`cap:`) já trocadas
   * pelo que roda neste provedor e modo (`Capability.Catalog`). Os adapters nunca veem `cap:`.
   */
  private prepare(agent: IAgent, projectId: string | undefined, providerId: string, protocol: EProvider, mode: EMode): { agent: IAgent; unavailable: string[] } {
    const official = this.providers?.get(providerId)?.official ?? Object.values(EProvider).includes(providerId as EProvider)
    const { allowedTools, unavailable } = resolveCapabilities(this.withDocs(agent, projectId).allowedTools, { protocol, official, mode })
    // ⛔ Agente compartilhado numa conversa do projeto que o recebe: para o adapter ele é como o GLOBAL naquele projeto (a pasta,
    // o cerco, as regras, as contas e os MCPs são os da conversa); as skills, os commands e as specs dele seguem os da origem
    // (o guidance lê o agente do cadastro, não este).
    const { sharedWith: _shared, ...plain } = agent
    return { agent: runsUnder(agent, projectId) === agent.projectId ? { ...agent, allowedTools } : { ...plain, projectId: undefined, allowedTools }, unavailable }
  }

  /**
   * O agente com o `read_doc` quando a conversa tem documento no índice, com o `use_resource` e o `search_resources`
   * quando ele tem skill, command ou trigger, e com o `ledger_read`/`ledger_write` quando o gateway tem ledger: o prompt
   * manda usar, então a ferramenta vem junto, sem ninguém ter de escolhê-la no cadastro do agente.
   */
  private withDocs(agent: IAgent, projectId: string | undefined): IAgent {
    const extra = [
      ...(this.guidance?.hasDocs(projectId, agent.id) ? [READ_DOC_TOOL, SEARCH_DOCS_TOOL] : []),
      ...(this.guidance?.hasResources?.(agent.id) ? [USE_RESOURCE_TOOL, SEARCH_RESOURCES_TOOL] : []),
      // O ledger: todo agente lê e escreve o PRÓPRIO (o dono é o agente do turno, ver `Ledger.Tools`).
      ...(this.guidance?.hasLedger?.() ? LEDGER_TOOLS : []),
      // O painel da conversa: todo agente mantém o da conversa em que está.
      ...(this.panels ? [PANEL_TOOL] : []),
    ].filter((tool) => !agent.allowedTools.includes(tool))
    return extra.length ? { ...agent, allowedTools: [...agent.allowedTools, ...extra] } : agent
  }

  /**
   * ⚖️ A RETOMADA: a sessão vive na memória e some depois de horas parada ou num reinício; a conversa, não — está no
   * banco. Reabre pelo caminho normal (`createSession`: valem as regras de hoje — agente apagado, modelo desligado,
   * só admin), devolve a sessão ao id da conversa e semeia o que o banco tinha (turnos, consumo, transcrição), para o
   * próximo `saveSession` não zerar os totais nem regravar o título. O modelo recebe a transcrição no próximo turno.
   * ⛔ Conversa de subagente não volta: só a delegação abre uma.
   */
  async resume(input: IResumeInput): Promise<void> {
    const stored = input.session
    if (this.sessions.get(stored.id)) return
    // ⛔ Conversa de delegação só volta pela MÃE dela (a delegação continuando, ver `Delegation.Service`).
    const parent = stored.metadata?.delegatedBy
    if (parent && parent !== input.delegatedBy) throw new ConversationNotResumableError(stored.id, 'it belongs to a delegation, resumed only by the conversation that opened it')

    const last = input.turns[input.turns.length - 1]
    const created = await this.createSession({
      agentId: stored.agentId,
      provider: last?.provider ?? stored.provider,
      model: last?.model ?? stored.model,
      mode: stored.mode as EMode,
      ...(last?.effort ? { reasoning: last.effort } : {}),
      ...(stored.metadata ? { metadata: stored.metadata } : {}),
      ...(input.adminAccess ? { adminAccess: true } : {}),
      ...(typeof parent === 'string' ? { delegated: true, parentSessionId: parent } : {}),
    })
    if (!this.sessions.adopt(created.id, stored.id)) return
    const adminScope = this.adminSessions.get(created.id)
    if (this.adminSessions.delete(created.id)) this.adminSessions.set(stored.id, adminScope ?? null)

    const record = this.sessions.get(stored.id)!
    const transcript = input.turns.map((turn) => ({
      request: turn.request,
      ...(turn.files?.length ? { files: turn.files.map((file) => file.name) } : {}),
      text: turn.text,
      tools: turn.toolCalls.map((call) => call.tool),
      by: `${turn.provider ?? stored.provider} · ${turn.model ?? stored.model}`,
    }))
    record.turns = stored.turns
    record.usage = liveUsage(stored.usage)
    record.usageByModel = stored.usageByModel
      ? Object.fromEntries(Object.entries(stored.usageByModel).map(([key, usage]) => [key, liveUsage(usage)]))
      : { [usageKey(stored.provider, stored.model)]: liveUsage(stored.usage) }
    record.transcript = transcript
    // ⚖️ A MEMÓRIA DO SDK, quando ainda serve (mesma lane, e o adapter confirma que o estado existe): a conversa segue
    // inteira, com o que as ferramentas devolveram e o raciocínio — sem a transcrição. Senão, a transcrição.
    const native = input.native
    const adapter = this.getAdapter(record.protocol, record.mode)
    if (native && native.protocol === record.protocol && native.mode === record.mode && adapter.restoreNative?.(stored.id, native.data)) return
    record.handoff = handoffText(transcript, HANDOFF_MAX_CHARS, 'resume')
    record.handoffKind = 'resume'
  }

  /** O estado do SDK da sessão para guardar com a conversa (só a lane que exporta, e depois que começou). */
  nativeSnapshot(sessionId: string): INativeSnapshot | null {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    const data = this.getAdapter(record.protocol, record.mode).exportNative?.(sessionId)
    return data === undefined ? null : { protocol: record.protocol, mode: record.mode, data }
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
    return this.view(this.requireSession(sessionId))
  }

  list(): ISession[] {
    return this.sessions.list().map((record) => this.view(record))
  }

  /** A sessão para fora, com o que só o adapter sabe: se a lane compacta o próprio contexto. */
  private view(record: ISessionRecord): ISession {
    const session = toSession(record)
    return this.adapters.get(adapterKey(record.protocol, record.mode))?.compactsItself ? { ...session, compactsItself: true } : session
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
      record.handoffKind = 'switch'
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
    // ⚖️ Sem escolha, com grupo de modelos: o primeiro passo dele que pode rodar agora (fora da reserva, modelo ativo).
    if (!asked) {
      const step = fallbackChain(groupOf(agent, settings)).find((candidate) => {
        if (this.isStepBenched(candidate)) return false
        const target = agent.providers.find((item) => item.provider === candidate.provider)
        return !!target && target.models.includes(candidate.model) && (this.agents.isTargetRunnable?.(agent, { ...target, models: [candidate.model] }) ?? true)
      })
      if (step) return step
    }
    // O provedor sem cota agora (ver `Provider.Bench`) não abre conversa nova enquanto houver outro.
    const runnable = (target: IAgentTarget) => !this.bench?.isBenched(target.provider) && (this.agents.isTargetRunnable?.(agent, target) ?? true)
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

    // ⚖️ Os passos do grupo de modelos entram como alvos do agente (só os modelos ativos): é o que a troca e a conversa
    // sem escolha usam, com o sandbox do agente (ver `withGroupTargets`).
    const group = groupOf(agent, this.current)
    return withGroupTargets(agent, group && { ...group, steps: group.steps.filter((step) => this.agents.isModelUsable?.(step.provider, step.model) ?? true) })
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
    ...(record.compactNext ? { compactNext: true } : {}),
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

/** O consumo gravado de volta ao formato da sessão (o `totalTokens` é calculado, não se semeia). */
function liveUsage(stored: IStoredUsage | undefined): IUsage {
  const { totalTokens: _total, ...usage } = stored ?? {}
  return usage
}

/**
 * ⛔ A PASTA DE TRABALHO da conversa aberta num repositório ou worktree (gravados na metadata pelo servidor): resolvida
 * de novo a cada turno, pela mesma regra da criação. A worktree que sumiu falha o turno com o motivo, nunca cai na
 * pasta do projeto inteiro.
 */
function workFolderOf(metadata: Record<string, unknown> | undefined, projectId: string | undefined): IContextWorkFolder | undefined {
  const repository = metadata?.[REPOSITORY_METADATA_KEY]
  if (typeof repository !== 'string' || !projectId) return undefined
  const worktree = metadata?.[WORKTREE_METADATA_KEY]
  const projectDir = projectWorkspace(projectId)
  const folder = resolveWorkFolder(projectDir, repository, typeof worktree === 'string' ? worktree : undefined)
  return { ...folder, projectDir }
}

/** A falha que trocou o passo, como a pessoa lê no aviso do turno. */
const FAILURE_LABEL: Readonly<Record<TProviderFailure, string>> = {
  quota: 'Cota esgotada',
  rate_limit: 'Limite de uso',
  model: 'Modelo indisponível',
  overloaded: 'Provedor sobrecarregado',
  auth: 'Credencial recusada',
  other: 'Falha',
}

/** O aviso que entra no turno quando o cliente do modelo corta a chamada de delegação (ver o laço do `sendMessage`). */
const DELEGATION_CUT_NOTICE =
  '[gateway] A sua chamada a delegate_to_agent foi cortada pelo cliente do modelo, mas a conversa com o outro agente CONTINUA no gateway. Não repita o pedido: a resposta dele entra nesta conversa, como mensagem, quando ele terminar. Enquanto isso, siga com o que não depende dela ou diga à pessoa que está esperando.'

/** O resultado de ferramenta que o CLI inventa quando a chamada cai no meio ("The tool call was interrupted…"). */
function interruptedCall(event: IAgentEvent): boolean {
  const payload = event.payload as { result?: unknown; message?: unknown }
  const text = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.result ?? '')
  return /tool call was interrupted|interrupted before a result|session ended before this call/i.test(text)
}
