import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { AUTO_TOOLS, isAutoToolOff } from '@domain/Auto.Tools'
import { AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { IAgentLocalLayer, isEmptyLayer, TAgentLocalLayerInput, trimLocalLayer } from '@domain/models/AgentLocalLayer.Model'
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
    if (isEmptyLayer(layer)) this.deps.repository.remove(agentId)
    else this.deps.repository.save({ agentId, ...layer, updatedAt: this.now(), updatedBy: by })
    return this.view(agent, this.deps.repository.get(agentId))
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
    if (!this.validation) throw new Error('agent validation is not wired (useAgentValidation)')
    const { rules, issues: projectIssues } = await this.validation()
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
