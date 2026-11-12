import { agentIssues } from '@domain/Agent.Policy'
import { AUTO_TOOLS, isAutoToolOff } from '@domain/Auto.Tools'
import { AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentProjectLayer, isEmptyLayer, mergeLocalLayer, TAgentLocalLayerInput, trimLocalLayer } from '@domain/models/AgentLocalLayer.Model'
import { IAgentProjectLayerRepository } from '@domain/ports/AgentProjectLayerRepository.Port'
import { cleanRules, IPermissionRule, permissionIssues } from '@domain/Permission.Policy'
import type { AgentCatalog } from './Agent.Catalog'
import type { IAgentLayerValidation, IAgentLocalLayerView } from './AgentLocalLayer.Service'

type TIssue = { field: string; message: string }

export interface IAgentProjectLayerDeps {
  repository: IAgentProjectLayerRepository
  agents: Pick<AgentCatalog, 'entry'>
  /** O projeto existe? */
  projectExists(projectId: string): boolean
  now?: () => Date
}

/**
 * ⚖️ A CAMADA DO PROJETO dos agentes GLOBAIS (ver `IAgentProjectLayer`): o que cada projeto acrescenta ou desliga no
 * agente que é de todos — modelos, ferramentas, MCPs, delegação e regras. A base não muda aqui; a camada só vale nas
 * conversas do projeto dela (`AgentCatalog.getIn`).
 *
 * ⛔ A camada é conferida como o agente que RODA no projeto: o MCP tem de servir ao projeto, a delegação só vai a agente
 * dele ou global. Quem grava é a pessoa na tela (a rota confere); agente nenhum amplia a si mesmo por aqui.
 */
export class AgentProjectLayerService {
  private readonly now: () => Date
  private validation?: () => Promise<IAgentLayerValidation>

  constructor(private readonly deps: IAgentProjectLayerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  useAgentValidation(validation: () => Promise<IAgentLayerValidation>): void {
    this.validation = validation
  }

  /** A camada que entra no agente que roda num projeto: só a de agente global. */
  of(agent: Pick<IAgent, 'id' | 'projectId'>, projectId: string | undefined): IAgentProjectLayer | undefined {
    if (agent.projectId || !projectId) return undefined
    return this.deps.repository.get(agent.id, projectId)
  }

  /** O agente como roda no projeto: a base com a camada dele por cima. */
  apply(agent: IAgent, projectId: string | undefined): IAgent {
    const layer = this.of(agent, projectId)
    return layer ? mergeLocalLayer(agent, layer) : agent
  }

  /** As regras do agente no projeto: as da base e as que a camada acrescenta. */
  rules(agent: Pick<IAgent, 'id' | 'projectId' | 'permissions'>, projectId: string | undefined): readonly IPermissionRule[] | undefined {
    const layer = this.of(agent, projectId)
    if (!layer?.permissions.length) return agent.permissions
    return [...(agent.permissions ?? []), ...layer.permissions]
  }

  get(projectId: string, agentId: string): IAgentLocalLayerView {
    const agent = this.agent(projectId, agentId)
    return this.view(agent, projectId, this.deps.repository.get(agentId, projectId))
  }

  /** Grava a camada inteira. Vazia, é o mesmo que apagar. */
  async save(projectId: string, agentId: string, input: TAgentLocalLayerInput, by: string): Promise<IAgentLocalLayerView> {
    const agent = this.agent(projectId, agentId)
    if (!this.validation) throw new Error('agent validation is not wired (useAgentValidation)')
    const layer = this.checked(await this.validation(), agent, projectId, input)
    if (isEmptyLayer(layer)) this.deps.repository.remove(agentId, projectId)
    else this.deps.repository.save({ agentId, projectId, ...layer, updatedAt: this.now(), updatedBy: by })
    return this.view(agent, projectId, this.deps.repository.get(agentId, projectId))
  }

  remove(projectId: string, agentId: string): IAgentLocalLayerView {
    const agent = this.agent(projectId, agentId)
    this.deps.repository.remove(agentId, projectId)
    return this.view(agent, projectId, undefined)
  }

  /** O agente saiu: as camadas dele vão junto, e ninguém mais delega a ele por uma camada. */
  forget(agentId: string): void {
    this.deps.repository.removeAgent(agentId)
    const ref = `agent:${agentId}`
    for (const layer of this.deps.repository.list().filter((item) => item.allowedTools.includes(ref) || item.disabledTools?.includes(ref))) {
      const disabledTools = (layer.disabledTools ?? []).filter((tool) => tool !== ref)
      const { disabledTools: _before, ...rest } = layer
      const next = { ...rest, allowedTools: layer.allowedTools.filter((tool) => tool !== ref), ...(disabledTools.length ? { disabledTools } : {}) }
      if (isEmptyLayer(next)) this.deps.repository.remove(layer.agentId, layer.projectId)
      else this.deps.repository.save(next)
    }
  }

  removeProject(projectId: string): void {
    this.deps.repository.removeProject(projectId)
  }

  /** O agente gravado (a base), só se for GLOBAL, num projeto que existe. */
  private agent(projectId: string, agentId: string): IAgent {
    const agent = this.deps.agents.entry(agentId)?.agent
    if (!agent || !this.deps.projectExists(projectId)) throw new AgentNotFoundError(agentId)
    if (agent.projectId) throw new InvalidAgentError([{ field: 'projectId', message: `${agentId} is a project agent: only a global agent has a project layer` }])
    return agent
  }

  /**
   * ⛔ A camada conferida com as regras do cadastro, no agente como ele vai rodar NO PROJETO (`projectId` = o da camada):
   * MCP que serve ao projeto, delegação a agente dele ou global, modelo ligado, ferramenta conhecida. Só o que é DA
   * CAMADA trava: um problema da base não é do projeto resolver.
   */
  private checked({ rules, issues: projectIssues }: IAgentLayerValidation, agent: IAgent, projectId: string, input: TAgentLocalLayerInput): TAgentLocalLayerInput {
    const issues: TIssue[] = [...permissionIssues(input.permissions)]
    for (const tool of input.allowedTools.filter(isAutoToolOff))
      issues.push({ field: 'allowedTools', message: `allowedTools cannot turn off a tool (${tool}): list its name in disabledTools` })
    if (issues.length) throw new InvalidAgentError(issues)

    const layer = trimLocalLayer(agent, { ...input, permissions: cleanRules(input.permissions) })
    const candidate: IAgent = {
      ...agent,
      projectId,
      providers: layer.providers ?? agent.providers,
      allowedTools: layer.allowedTools.filter((tool) => !AUTO_TOOLS.includes(tool)),
      permissions: layer.permissions,
    }
    const mine = (field: string) =>
      field === 'allowedTools' || field === 'permissions' || field.startsWith('permissions[') || (!!layer.providers && ['providers', 'models', 'modes'].includes(field))
    const all = [...projectIssues(candidate), ...agentIssues(candidate, { ...rules, takenIds: [] })].filter((issue) => mine(issue.field))
    // As lanes são da base: basta os modelos da camada rodarem UMA delas.
    const lanes = all.filter((issue) => issue.field === 'modes')
    const found = all
      .filter((issue) => issue.field !== 'modes' || lanes.length >= candidate.modes.length)
      .map((issue) => (issue.field === 'modes' ? { ...issue, field: 'providers' } : issue))
    if (found.length) throw new InvalidAgentError(found)
    return layer
  }

  private view(agent: IAgent, projectId: string, layer: IAgentProjectLayer | undefined): IAgentLocalLayerView {
    return {
      agentId: agent.id,
      projectId,
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
