import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { agentWidenings } from '@domain/AgentPatch.Policy'
import { AUTO_TOOLS, isAutoToolOff } from '@domain/Auto.Tools'
import { toCapabilities } from '@domain/Capability.Catalog'
import { AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentLocalLayer, isEmptyLayer, mergeLocalLayer, TAgentLocalLayerInput, trimLocalLayer } from '@domain/models/AgentLocalLayer.Model'
import { IAgentLocalLayerRepository } from '@domain/ports/AgentLocalLayerRepository.Port'
import { cleanRules, IPermissionRule, permissionIssues } from '@domain/Permission.Policy'
import type { AgentCatalog } from './Agent.Catalog'

type TIssue = { field: string; message: string }

export interface IAgentLocalLayerDeps {
  repository: IAgentLocalLayerRepository
  agents: Pick<AgentCatalog, 'entry' | 'rawEntries' | 'applyLocalLayer'>
  /** O projeto está conectado? A camada só existe (e só vale) nele. */
  connected(projectId: string): boolean
  now?: () => Date
}

/** As regras do momento para conferir a camada: as mesmas do `PUT /agents` (vêm do controller dos agentes). */
export interface IAgentLayerValidation {
  rules: Omit<IAgentRules, 'takenIds'>
  issues(agent: IAgent): TIssue[]
}

/** O ajuste que não amplia: o que desligar (soma ao já desligado; o que foi ligado AQUI sai da camada) e os modelos daqui (`null` = os da origem). */
export interface IAgentLocalLayerAdjust {
  disabledTools?: string[]
  providers?: IAgentTarget[] | null
}

/** Ligar ferramentas aqui (ver `enabling`): o agente antes e depois, a conferência e a gravação. */
export interface IAgentLocalEnabling {
  before: IAgent
  after: IAgent
  /** ⛔ Lança `InvalidAgentError` com o que a camada nova não pode ter (MCP que não existe, agente de outro projeto). */
  check(validation: IAgentLayerValidation): void
  save(validation: IAgentLayerValidation, by: string): void
}

/** O que a tela mostra: a origem e o que esta máquina acrescentou ou desligou. */
export interface IAgentLocalLayerView {
  agentId: string
  projectId: string
  origin: { providers: IAgentTarget[]; allowedTools: string[]; permissions: IPermissionRule[] }
  layer: TAgentLocalLayerInput
  updatedAt?: Date
  updatedBy?: string
}

/**
 * 🔌 A camada local dos agentes de projeto conectado (ver `AgentLocalLayer.Model`): modelos, ferramentas, MCPs,
 * delegação e permissões que só valem nesta máquina. O que veio da origem não muda aqui: a camada soma, e desliga pelo
 * nome o que não serve neste ambiente.
 */
export class AgentLocalLayerService {
  private readonly now: () => Date
  private validation?: () => Promise<IAgentLayerValidation>

  constructor(private readonly deps: IAgentLocalLayerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  useAgentValidation(validation: () => Promise<IAgentLayerValidation>): void {
    this.validation = validation
  }

  /** A camada que entra no agente que roda: só a de agente de projeto conectado. */
  of(agent: Pick<IAgent, 'id' | 'projectId'>): IAgentLocalLayer | undefined {
    const layer = this.deps.repository.get(agent.id)
    return layer && agent.projectId && this.deps.connected(agent.projectId) ? layer : undefined
  }

  /** O que a camada ACRESCENTA a um agente de projeto conectado (`undefined` = o agente não é de projeto conectado). */
  extras(agent: Pick<IAgent, 'id' | 'projectId'>): readonly string[] | undefined {
    if (!agent.projectId || !this.deps.connected(agent.projectId)) return undefined
    return this.deps.repository.get(agent.id)?.allowedTools ?? []
  }

  get(projectId: string, agentId: string): IAgentLocalLayerView {
    const agent = this.agent(projectId, agentId)
    return this.view(agent, this.deps.repository.get(agentId))
  }

  /** Grava a camada inteira. Vazia, é o mesmo que apagar. */
  async save(projectId: string, agentId: string, input: TAgentLocalLayerInput, by: string): Promise<IAgentLocalLayerView> {
    const agent = this.agent(projectId, agentId)
    const layer = await this.checked(agent, input)
    this.store(agentId, layer, by)
    return this.view(agent, this.deps.repository.get(agentId))
  }

  /**
   * 🔌 O AJUSTE QUE UM AGENTE FAZ (`patch_agent` com `localLayer`): desligar o que veio da origem e trocar os modelos
   * desta máquina. Vale na hora, e só aqui: a origem não muda.
   * ⛔ Nunca amplia: o que está desligado continua desligado (religar é na tela), ferramenta e regra a mais não entram
   * por aqui, e os modelos novos não ganham sandbox mais solto nem rede. O que a camada tinha LIGADO a mais sai dela
   * quando é pedido. `ignored` = o que o agente não tem para desligar.
   */
  async adjust(projectId: string, agentId: string, change: IAgentLocalLayerAdjust, by: string): Promise<IAgentLocalLayerView & { ignored: string[] }> {
    const agent = this.agent(projectId, agentId)
    const current = inputOf(this.deps.repository.get(agentId))
    const asked = new Set(change.disabledTools ?? [])
    const providers = change.providers === undefined ? current.providers : (change.providers ?? undefined)
    // As ferramentas só encolhem por construção; o que pode ampliar é o sandbox e a rede dos modelos novos.
    const before = mergeLocalLayer(agent, current)
    const widenings = agentWidenings(before, { ...before, providers: providers?.length ? providers : agent.providers })
    if (widenings.length)
      throw new InvalidAgentError(
        widenings.map((widening) => ({ field: 'providers', message: `${widening.description}: o que amplia acesso é feito na tela do agente (guia Modelos)` })),
      )
    const layer = await this.checked(agent, {
      ...(providers?.length ? { providers } : {}),
      allowedTools: current.allowedTools.filter((tool) => !asked.has(tool)),
      disabledTools: [...new Set([...(current.disabledTools ?? []), ...asked])],
      permissions: current.permissions,
    })
    this.store(agentId, layer, by)
    const ignored = [...asked].filter((tool) => !layer.disabledTools?.includes(tool) && !current.allowedTools.includes(tool))
    return { ...this.view(agent, this.deps.repository.get(agentId)), ignored }
  }

  /**
   * 🔌 LIGAR ferramentas, MCPs e delegações AQUI (o pedido `agent-local`, aprovado na tela): o agente como roda agora
   * (`before`) e como rodaria com elas (`after`) — a que a camada tinha desligado volta, a que não veio da origem entra
   * a mais. O id antigo (`run_bash`) vale como a capacidade dele. `undefined` = o agente não é de projeto conectado.
   * ⚖️ Tudo síncrono: `check` confere com as regras do cadastro que quem chama já leu (o pedido já nasce conferido), e
   * `save` confere de novo e grava na mesma volta.
   */
  enabling(agent: IAgent, tools: readonly string[]): IAgentLocalEnabling | undefined {
    if (!agent.projectId || !this.deps.connected(agent.projectId)) return undefined
    const current = inputOf(this.deps.repository.get(agent.id))
    const off = new Set(current.disabledTools ?? [])
    const more: string[] = []
    for (const tool of tools) {
      const known = [tool, ...toCapabilities([tool])].filter((entry) => off.has(entry))
      if (known.length) known.forEach((entry) => off.delete(entry))
      else more.push(...toCapabilities([tool]))
    }
    const next = trimLocalLayer(agent, { ...current, allowedTools: [...current.allowedTools, ...more], disabledTools: [...off] })
    return {
      before: mergeLocalLayer(agent, current),
      after: mergeLocalLayer(agent, next),
      check: (validation) => void this.checkedWith(validation, agent, next),
      save: (validation, by) => this.store(agent.id, this.checkedWith(validation, agent, next), by),
    }
  }

  remove(projectId: string, agentId: string): IAgentLocalLayerView {
    const agent = this.agent(projectId, agentId)
    this.deps.repository.remove(agentId)
    return this.view(agent, undefined)
  }

  /** As regras locais de um agente conectado, para os pedidos de permissão: lidas e gravadas AQUI, não no agente. */
  localRules(agent: Pick<IAgent, 'id' | 'projectId'>): { rules: IPermissionRule[]; save(rules: readonly IPermissionRule[], by: string): IPermissionRule[] } | undefined {
    if (!agent.projectId || !this.deps.connected(agent.projectId)) return undefined
    return {
      rules: this.deps.repository.get(agent.id)?.permissions ?? [],
      save: (rules, by) => {
        const issues = permissionIssues(rules)
        if (issues.length) throw new InvalidAgentError(issues)
        const current = this.deps.repository.get(agent.id)
        const layer = {
          ...(current?.providers ? { providers: current.providers } : {}),
          allowedTools: current?.allowedTools ?? [],
          ...(current?.disabledTools?.length ? { disabledTools: current.disabledTools } : {}),
          permissions: cleanRules(rules),
        }
        if (isEmptyLayer(layer)) this.deps.repository.remove(agent.id)
        else this.deps.repository.save({ agentId: agent.id, ...layer, updatedAt: this.now(), updatedBy: by })
        return layer.permissions
      },
    }
  }

  /** Desconectar o projeto: cada camada passa a ser do próprio agente, e some daqui. */
  applyAll(projectId: string, by: string): void {
    for (const { agent } of this.deps.agents.rawEntries().filter((entry) => entry.agent.projectId === projectId)) {
      const layer = this.deps.repository.get(agent.id)
      if (!layer) continue
      this.deps.agents.applyLocalLayer(agent.id, layer, by)
      this.deps.repository.remove(agent.id)
    }
  }

  /** O agente saiu (a origem o removeu): a camada dele vai junto, e ninguém mais delega a ele por uma camada. */
  forget(agentId: string): void {
    this.deps.repository.remove(agentId)
    const ref = `agent:${agentId}`
    for (const layer of this.deps.repository.list().filter((item) => item.allowedTools.includes(ref) || item.disabledTools?.includes(ref))) {
      const disabledTools = (layer.disabledTools ?? []).filter((tool) => tool !== ref)
      const { disabledTools: _before, ...rest } = layer
      const next = { ...rest, allowedTools: layer.allowedTools.filter((tool) => tool !== ref), ...(disabledTools.length ? { disabledTools } : {}) }
      if (isEmptyLayer(next)) this.deps.repository.remove(layer.agentId)
      else this.deps.repository.save(next)
    }
  }

  /** O agente gravado (a origem), só se for do projeto conectado pedido. */
  private agent(projectId: string, agentId: string): IAgent {
    const agent = this.deps.agents.entry(agentId)?.agent
    if (!agent || agent.projectId !== projectId || !this.deps.connected(projectId)) throw new AgentNotFoundError(agentId)
    return agent
  }

  /**
   * ⛔ A camada conferida com as regras do cadastro, no agente como ele vai rodar: MCP que existe, agente de delegação
   * que existe e é do projeto (ou global), modelo ligado aqui, ferramenta conhecida. Só o que é DA CAMADA trava: um
   * problema do que veio da origem não é desta máquina resolver.
   */
  private async checked(agent: IAgent, input: TAgentLocalLayerInput): Promise<TAgentLocalLayerInput> {
    if (!this.validation) throw new Error('agent validation is not wired (useAgentValidation)')
    return this.checkedWith(await this.validation(), agent, input)
  }

  private checkedWith({ rules, issues: projectIssues }: IAgentLayerValidation, agent: IAgent, input: TAgentLocalLayerInput): TAgentLocalLayerInput {
    const issues: TIssue[] = [...permissionIssues(input.permissions)]
    for (const tool of input.allowedTools.filter(isAutoToolOff))
      issues.push({ field: 'allowedTools', message: `allowedTools cannot turn off a tool (${tool}): list its name in disabledTools` })
    if (issues.length) throw new InvalidAgentError(issues)

    const layer = trimLocalLayer(agent, { ...input, permissions: cleanRules(input.permissions) })
    const candidate: IAgent = {
      ...agent,
      providers: layer.providers ?? agent.providers,
      allowedTools: layer.allowedTools.filter((tool) => !AUTO_TOOLS.includes(tool)),
      permissions: layer.permissions,
    }
    // Os campos da camada. `modes` fala dos provedores (o protocolo não roda a lane do agente): vai para a guia Modelos.
    const mine = (field: string) =>
      field === 'allowedTools' || field === 'permissions' || field.startsWith('permissions[') || (!!layer.providers && ['providers', 'models', 'modes'].includes(field))
    const all = [...projectIssues(candidate), ...agentIssues(candidate, { ...rules, takenIds: [] })].filter((issue) => mine(issue.field))
    // ⚖️ As lanes são da origem e não mudam aqui: basta os modelos locais rodarem UMA delas (a sessão abre na que
    // o provedor atende, ver `resolveSessionMode`). Só trava quando não sobra lane nenhuma.
    const lanes = all.filter((issue) => issue.field === 'modes')
    const found = all
      .filter((issue) => issue.field !== 'modes' || lanes.length >= candidate.modes.length)
      .map((issue) => (issue.field === 'modes' ? { ...issue, field: 'providers' } : issue))
    if (found.length) throw new InvalidAgentError(found)
    return layer
  }

  /** Grava a camada conferida; vazia, é o mesmo que apagar. */
  private store(agentId: string, layer: TAgentLocalLayerInput, by: string): void {
    if (isEmptyLayer(layer)) this.deps.repository.remove(agentId)
    else this.deps.repository.save({ agentId, ...layer, updatedAt: this.now(), updatedBy: by })
  }

  private view(agent: IAgent, layer: IAgentLocalLayer | undefined): IAgentLocalLayerView {
    return {
      agentId: agent.id,
      projectId: agent.projectId!,
      origin: { providers: agent.providers, allowedTools: agent.allowedTools, permissions: agent.permissions ?? [] },
      layer: {
        ...(layer?.providers ? { providers: layer.providers } : {}),
        allowedTools: layer?.allowedTools ?? [],
        disabledTools: layer?.disabledTools ?? [],
        permissions: layer?.permissions ?? [],
      },
      ...(layer ? { updatedAt: layer.updatedAt, updatedBy: layer.updatedBy } : {}),
    }
  }
}

/** A camada gravada como entrada (a que não existe é a vazia). */
const inputOf = (stored: IAgentLocalLayer | undefined): TAgentLocalLayerInput => ({
  ...(stored?.providers ? { providers: stored.providers } : {}),
  allowedTools: stored?.allowedTools ?? [],
  disabledTools: stored?.disabledTools ?? [],
  permissions: stored?.permissions ?? [],
})
