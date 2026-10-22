import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { AgentNotFoundError, InvalidAgentError, ReadOnlyAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentDirectory, IAgentRepository, IStoredAgent } from '@domain/ports/AgentRepository.Port'

/** Um agente na lista da tela: de onde veio, e — se foi criado — quem mexeu por último. */
export interface IAgentEntry {
  agent: IAgent
  builtIn: boolean
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
 * Os agentes do gateway: os EMBUTIDOS (código, filtrados por `AGENTS_ENABLED`) e os CRIADOS pela tela.
 *
 * ⚖️ O EMBUTIDO VENCE. Um id embutido nunca é tomado por um criado (a regra recusa na criação), mas se
 * um arquivo antigo tiver um — um agente que virou embutido depois de criado —, é o do código que
 * responde: ele é o que foi revisado.
 *
 * ⛔ EMBUTIDO É SÓ LEITURA. Editar o `sysops-agent` pela tela seria trocar o que o código declara
 * sem passar por revisão nenhuma; para mudar, duplica-se e edita-se a cópia.
 *
 * ⚠️ Sessão já aberta fica com o agente com que nasceu: o adapter compõe o prompt na criação, e
 * mudar o agente aqui vale para a PRÓXIMA sessão.
 */
export class AgentCatalog implements IAgentDirectory {
  constructor(
    private readonly builtIns: readonly IAgent[],
    private readonly repository: IAgentRepository,
    /**
     * Quais modelos do agente podem ser usados AGORA — os ativados no catálogo do provider. Ausente,
     * todos os declarados. ⚖️ Desativar um modelo o tira de TODOS os agentes na leitura, sem reescrever
     * nenhum: religar devolve.
     */
    private readonly usable?: (providerId: string, modelId: string) => boolean,
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
    const builtInIds = new Set(this.builtIns.map((agent) => agent.id))
    const custom = this.repository.list().filter((agent) => !builtInIds.has(agent.id))

    return [
      ...this.builtIns.map((agent) => ({ agent, builtIn: true })),
      ...custom.map((stored) => ({ agent: toAgent(stored), builtIn: false, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy })),
    ]
  }

  get(id: string): IAgent | undefined {
    return this.list().find((agent) => agent.id === id)
  }

  /** Os modelos declarados que estão DESLIGADOS no catálogo — a tela de edição os mostra marcados. */
  unusableModels(agent: IAgent): string[] {
    return this.usable ? agent.models.filter((model) => !this.usable!(agent.provider, model)) : []
  }

  private effective(agent: IAgent): IAgent {
    return this.usable ? { ...agent, models: agent.models.filter((model) => this.usable!(agent.provider, model)) } : agent
  }

  /** O agente como gravado, para editar: os modelos desligados aparecem (ver `unusableModels`). */
  entry(id: string): IAgentEntry | undefined {
    return this.rawEntries().find((entry) => entry.agent.id === id)
  }

  /** O que vale quando ninguém escolheu agente: o primeiro embutido, senão o primeiro criado. */
  fallback(): IAgent | undefined {
    return this.list()[0]
  }

  isBuiltIn(id: string): boolean {
    return this.builtIns.some((agent) => agent.id === id)
  }

  save(agent: IAgent, options: ISaveAgentOptions): IStoredAgent {
    if (this.isBuiltIn(agent.id)) {
      if (!options.creating) throw new ReadOnlyAgentError(agent.id)
    } else if (!options.creating && !this.repository.list().some((stored) => stored.id === agent.id)) {
      throw new AgentNotFoundError(agent.id)
    }

    // Na criação nenhum id existente serve; na atualização, só os embutidos (o próprio é este).
    const takenIds = options.creating ? this.list().map((existing) => existing.id) : this.builtIns.map((existing) => existing.id)
    const issues = agentIssues(agent, { ...options.rules, takenIds })
    if (issues.length) throw new InvalidAgentError(issues)

    return this.repository.save(agent, options.by)
  }

  remove(id: string): void {
    if (this.isBuiltIn(id)) throw new ReadOnlyAgentError(id)
    if (!this.repository.delete(id)) throw new AgentNotFoundError(id)
  }
}

/** Só os campos do agente: datas e autoria são do registro, não do contrato. */
function toAgent(stored: IStoredAgent): IAgent {
  return {
    id: stored.id,
    name: stored.name,
    provider: stored.provider,
    systemPrompt: stored.systemPrompt,
    models: stored.models,
    reasoningEfforts: stored.reasoningEfforts,
    modes: stored.modes,
    allowedTools: stored.allowedTools,
  }
}
