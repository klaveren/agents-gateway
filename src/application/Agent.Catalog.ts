import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { AgentInUseError, AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentDirectory, IAgentRepository, IStoredAgent } from '@domain/ports/AgentRepository.Port'

/** Um agente na lista da tela, com quem mexeu por último. */
export interface IAgentEntry {
  agent: IAgent
  updatedAt?: Date
  updatedBy?: string
}

/** O que `AgentCatalog.save` precisa além do agente: as regras do momento e quem está salvando. */
export interface ISaveAgentOptions {
  rules: Omit<IAgentRules, 'takenIds'>
  by: string
  /** `true` cria (o id não pode existir); `false` atualiza (o id tem de existir). */
  creating: boolean
}

/**
 * Os agentes do gateway — todos no banco, editáveis e apagáveis (a semente entra uma vez, ver `seedOnce`).
 *
 * ⚠️ Sessão já aberta fica com o agente com que nasceu: o adapter compõe o prompt na criação, e
 * mudar o agente aqui vale para a PRÓXIMA sessão.
 */
export class AgentCatalog implements IAgentDirectory {
  constructor(
    private readonly repository: IAgentRepository,
    /**
     * Quais modelos do agente podem ser usados AGORA — os ativados no catálogo do provider. Ausente,
     * todos os declarados. ⚖️ Desativar um modelo o tira de TODOS os agentes na leitura, sem reescrever
     * nenhum: religar devolve.
     */
    private readonly usable?: (providerId: string, modelId: string) => boolean,
    /**
     * Um provider do agente pode rodar agora (ver `targetUnavailable`) — ligado, modelo ativo, chave.
     * Ausente: todo provider com modelo conta. O agente roda se algum provider roda: é o que escolhe o
     * PADRÃO, os alvos de delegação e o provider com que a sessão nasce.
     */
    private readonly runnable?: (agent: IAgent, target: IAgentTarget) => boolean,
  ) {}

  /** Os agentes com os modelos que podem ser usados agora. */
  list(): IAgent[] {
    return this.entries().map((entry) => entry.agent)
  }

  /** Como `rawEntries`, com os modelos filtrados pelo catálogo — o que a API e as sessões enxergam. */
  entries(): IAgentEntry[] {
    return this.rawEntries().map((entry) => ({ ...entry, agent: this.effective(entry.agent) }))
  }

  /** Os agentes COMO GRAVADOS (todos os modelos declarados) — a tela de edição e a semente do catálogo. */
  rawEntries(): IAgentEntry[] {
    return this.repository.list().map((stored) => ({ agent: toAgent(stored), updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }))
  }

  get(id: string): IAgent | undefined {
    return this.list().find((agent) => agent.id === id)
  }

  /** Os modelos declarados que estão DESLIGADOS no catálogo — a tela de edição os mostra marcados. */
  unusableModels(agent: IAgent): Record<string, string[]> {
    if (!this.usable) return {}
    return Object.fromEntries(
      agent.providers.map((target) => [target.provider, target.models.filter((model) => !this.usable!(target.provider, model))] as const).filter(([, models]) => models.length),
    )
  }

  private effective(agent: IAgent): IAgent {
    if (!this.usable) return agent
    return { ...agent, providers: agent.providers.map((target) => ({ ...target, models: target.models.filter((model) => this.usable!(target.provider, model)) })) }
  }

  /** O agente como gravado, para editar: os modelos desligados aparecem (ver `unusableModels`). */
  entry(id: string): IAgentEntry | undefined {
    return this.rawEntries().find((entry) => entry.agent.id === id)
  }

  /**
   * O que vale quando ninguém escolheu agente: o primeiro que PODE abrir conversa e não é subagente.
   * ⚠️ Antes era só o primeiro da lista — que podia estar com o provider desligado, sem modelo ou ser
   * subagente, e toda conversa sem agente escolhido falhava.
   */
  fallback(): IAgent | undefined {
    return this.list().find((agent) => agent.role !== 'subagent' && this.isRunnable(agent))
  }

  /** O agente (já com os modelos utilizáveis) pode abrir conversa agora: algum provider dele roda. */
  isRunnable(agent: IAgent): boolean {
    return agent.providers.some((target) => this.isTargetRunnable(agent, target))
  }

  /** Este provider do agente (já com os modelos utilizáveis) pode rodar agora. */
  isTargetRunnable(agent: IAgent, target: IAgentTarget): boolean {
    return target.models.length > 0 && (this.runnable ? this.runnable(agent, target) : true)
  }

  save(agent: IAgent, options: ISaveAgentOptions): IStoredAgent {
    if (!options.creating && !this.repository.list().some((stored) => stored.id === agent.id)) throw new AgentNotFoundError(agent.id)

    // Na criação nenhum id existente serve; na atualização, o próprio é este.
    const takenIds = options.creating ? this.list().map((existing) => existing.id) : []
    const issues = agentIssues(agent, { ...options.rules, takenIds })
    if (issues.length) throw new InvalidAgentError(issues)

    return this.repository.save(agent, options.by)
  }

  /** Muda o agente de projeto sem passar pela regra do salvamento — só a migração para projetos usa. */
  moveToProject(id: string, projectId: string, by: string): void {
    const stored = this.repository.list().find((agent) => agent.id === id)
    if (stored) this.repository.save({ ...toAgent(stored), projectId }, by)
  }

  /**
   * ⛔ Não apaga agente que outro usa: um `agent:<id>` órfão travava todo salvamento do agente que delega,
   * e o padrão das configurações apagado fazia toda conversa sem agente escolhido falhar.
   */
  remove(id: string, options: { defaultAgentId?: string } = {}): void {
    const delegators = this.repository
      .list()
      .filter((agent) => agent.id !== id && agent.allowedTools.includes(`agent:${id}`))
      .map((agent) => agent.id)
    const isDefault = options.defaultAgentId === id
    if (delegators.length || isDefault) throw new AgentInUseError(id, delegators, isDefault)
    if (!this.repository.delete(id)) throw new AgentNotFoundError(id)
  }
}

/** Só os campos do agente: datas e autoria são do registro, não do contrato. */
function toAgent(stored: IStoredAgent): IAgent {
  return {
    id: stored.id,
    name: stored.name,
    providers: stored.providers.map((target) => ({
      provider: target.provider,
      models: [...target.models],
      ...(target.sandbox ? { sandbox: target.sandbox } : {}),
      ...(target.network ? { network: true } : {}),
    })),
    systemPrompt: stored.systemPrompt,
    ...(stored.soul ? { soul: stored.soul } : {}),
    reasoningEfforts: stored.reasoningEfforts,
    modes: stored.modes,
    allowedTools: stored.allowedTools,
    ...(stored.role ? { role: stored.role } : {}),
    ...(stored.adminOnly ? { adminOnly: true } : {}),
    ...(stored.projectId ? { projectId: stored.projectId } : {}),
  }
}
