import { ICatalogDocument, parseProtocolItemId } from '@domain/Catalog.Document'
import type { IAgentRules } from '@domain/Agent.Policy'
import { CatalogRestoreInvalidError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IMcpContainer, IMcpProcess, IMcpServerConfig, mcpServerKey, TMcpAuth, TMcpKind, TMcpTransport } from '@domain/models/McpServer.Model'
import { TDocKind } from '@domain/models/ProjectDoc.Model'
import { ALL_RESOURCES, IAgentResources, TResourceKind } from '@domain/models/Resource.Model'
import { IPermissionRule } from '@domain/Permission.Policy'
import type { AgentCatalog } from './Agent.Catalog'
import type { GuidanceService } from './Guidance.Service'
import type { McpServersService } from './McpServers.Service'
import type { PermissionsService } from './Permissions.Service'
import type { ProjectsService } from './Projects.Service'

type TIssues = Array<{ field: string; message: string }>

/**
 * Uma escrita PREPARADA: o que é assíncrono (as regras do momento) e as checagens que dão para fazer antes já foram
 * feitos. `commit` grava, SÍNCRONO (ver `CatalogHistoryService.within`).
 */
export interface IPreparedWrite {
  commit(by: string): void
  /** Os efeitos fora do banco, depois de gravar (fechar a instância de pé do MCP). */
  after?(): Promise<void>
  /** Os segredos que o item pede e o cofre não tem (só o MCP), lidos depois de gravar. */
  missingSecrets?(): string[]
}

/** Grava um documento canônico de volta no item, pelos serviços de escrita. */
export interface ICatalogWriter {
  /**
   * Prepara trocar `current` por `target` (ausente = apagar o item). ⛔ Lança `CatalogRestoreInvalidError` com os
   * problemas quando a versão não passa nas regras de HOJE.
   */
  prepare(target: ICatalogDocument | undefined, current: ICatalogDocument | undefined): Promise<IPreparedWrite>
}

export interface ICatalogWriterDeps {
  guidance: Pick<
    GuidanceService,
    | 'resource'
    | 'createResource'
    | 'updateResource'
    | 'deleteResource'
    | 'rule'
    | 'updateRule'
    | 'restoreRule'
    | 'deleteRule'
    | 'doc'
    | 'createDoc'
    | 'updateDoc'
    | 'deleteDoc'
    | 'setProtocolAddendum'
    | 'setInitialContext'
    | 'contextIssues'
    | 'setAgentResources'
    | 'setAgentContext'
    | 'agentLinkIssues'
  >
  permissions: Pick<PermissionsService, 'saveProjectRules'>
  mcps: Pick<McpServersService, 'list' | 'create' | 'update' | 'remove' | 'secretStatus' | 'envStatus'>
  /** Ausente = sem projetos: nem o projeto nem as permissões dele se restauram. */
  projects?: Pick<ProjectsService, 'exists' | 'create' | 'update'>
  agents: {
    catalog: Pick<AgentCatalog, 'save' | 'remove' | 'entry'>
    /** As regras do cadastro, lidas AGORA (as do `PUT /agents/:id`). */
    rules(): Promise<Omit<IAgentRules, 'takenIds'>>
    /** O que o cadastro confere além do domínio: o projeto existe, sandbox `full` no projeto, delegação cruzada. */
    issues(agent: IAgent): TIssues
    /** O agente padrão das configurações (não se apaga). */
    defaultAgentId(): Promise<string | undefined>
    /** O agente saiu: os ganchos, os vínculos e os agendamentos dele vão junto (o mesmo do `DELETE /agents/:id`). */
    removed(agentId: string): void
  }
  /** O MCP mudou: a instância de pé roda o cadastro de antes (o mesmo do `PUT /mcp-servers/:id`). */
  mcpChanged?(server: IMcpServerConfig): Promise<void>
  /** O MCP saiu: cliente, instâncias e pacote (o mesmo do `DELETE /mcp-servers/:id`). */
  mcpRemoved?(server: IMcpServerConfig): Promise<void>
}

const invalid = (field: string, message: string) => new CatalogRestoreInvalidError([{ field, message }])

/** Lê sem lançar: o serviço responde "não existe" com erro. */
function quietly<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/**
 * O ESCRITOR DO ROLLBACK: o documento canônico de volta no item, pelo MESMO caminho de escrita da tela — os serviços, com
 * as validações de domínio de sempre. Nada de gravar direto no repositório: a versão antiga que não passa mais nas regras
 * de hoje (um modelo desligado, um doc que sumiu, um MCP desligado) é recusada com os problemas.
 *
 * ⛔ SEGREDO NÃO VOLTA: o documento não leva segredo (ver `MCP_SHAPE`), e restaurar um MCP não mexe no cofre. O que
 * falta cadastrar vai no resultado (`missingSecrets`).
 *
 * ⚖️ O que NÃO se apaga por aqui: o projeto e as permissões dele. Apagar um projeto leva tudo o que é dele, e isso é
 * decisão da tela de Projetos, item a item à vista — não efeito colateral de um rollback.
 */
export class CatalogWriter implements ICatalogWriter {
  constructor(private readonly deps: ICatalogWriterDeps) {}

  async prepare(target: ICatalogDocument | undefined, current: ICatalogDocument | undefined): Promise<IPreparedWrite> {
    const doc = target ?? current
    if (!doc) return { commit: () => undefined }
    switch (doc.kind) {
      case 'agent':
        return target ? this.agent(target) : this.removeAgent(doc.id)
      case 'skill':
      case 'command':
        return target ? this.resource(target, doc.kind) : { commit: (by) => this.deps.guidance.deleteResource(doc.id, by) }
      case 'rule':
        return target ? this.rule(target) : { commit: (by) => this.deps.guidance.deleteRule(doc.id, by) }
      case 'spec':
      case 'adr':
      case 'knowledge':
        return target ? this.doc(target, doc.kind) : { commit: (by) => this.deps.guidance.deleteDoc(doc.id, by) }
      case 'protocol':
        return this.protocol(doc.id, target ? text(target.body.body) : '')
      case 'project':
        if (!target) throw invalid('project', 'a project is deleted on the Projects screen (it takes everything in it), not by a restore')
        return this.project(target)
      case 'project-permissions':
        if (!target) throw invalid('project', 'the project permissions go away only with the project')
        return this.projectPermissions(target)
      case 'mcp':
        return target ? this.mcp(target) : this.removeMcp(doc)
    }
  }

  // --- Agente -----------------------------------------------------------------------------------------------------

  private async agent(target: ICatalogDocument): Promise<IPreparedWrite> {
    const { resources, initialContext, ...fields } = target.body
    const agent = fields as unknown as IAgent
    const links = {
      resources: (resources as unknown as IAgentResources | undefined) ?? { skills: [ALL_RESOURCES], commands: [ALL_RESOURCES] },
      initialContext: list(initialContext),
    }
    const issues = [...this.deps.agents.issues(agent), ...this.deps.guidance.agentLinkIssues(agent.projectId, links)]
    if (issues.length) throw new CatalogRestoreInvalidError(issues)
    const creating = !this.deps.agents.catalog.entry(agent.id)
    const rules = await this.deps.agents.rules()
    return {
      commit: (by) => {
        // O agente primeiro (é o que pode recusar); os vínculos já foram conferidos acima.
        this.deps.agents.catalog.save(agent, { rules, by, creating })
        this.deps.guidance.setAgentResources(agent.id, links.resources, by)
        this.deps.guidance.setAgentContext(agent.id, links.initialContext, by)
      },
    }
  }

  private async removeAgent(id: string): Promise<IPreparedWrite> {
    const defaultAgentId = await this.deps.agents.defaultAgentId()
    return {
      commit: (by) => {
        this.deps.agents.catalog.remove(id, by, { defaultAgentId })
        this.deps.agents.removed(id)
      },
    }
  }

  // --- Skill, command, rule, docs, complemento ---------------------------------------------------------------------

  private resource(target: ICatalogDocument, kind: TResourceKind): IPreparedWrite {
    const { guidance } = this.deps
    const existing = quietly(() => guidance.resource(target.id))
    if (existing && existing.kind !== kind) throw invalid('id', `already used by the ${existing.kind} ${target.id}`)
    const body = target.body
    const input = {
      projectId: text(body.projectId) || null,
      description: text(body.description),
      body: text(body.body),
      docIds: list(body.docIds),
      docRefs: list(body.docRefs),
    }
    return {
      commit: (by) => {
        if (existing) guidance.updateResource(target.id, input, by)
        else guidance.createResource({ ...input, id: target.id, kind }, by)
      },
    }
  }

  private rule(target: ICatalogDocument): IPreparedWrite {
    const { guidance } = this.deps
    const exists = !!quietly(() => guidance.rule(target.id))
    const body = target.body
    const input = { projectId: text(body.projectId) || null, title: text(body.title), body: text(body.body), enabled: body.enabled !== false }
    return {
      commit: (by) => {
        if (exists) guidance.updateRule(target.id, input, by)
        else guidance.restoreRule({ ...input, id: target.id }, by)
      },
    }
  }

  private doc(target: ICatalogDocument, kind: TDocKind): IPreparedWrite {
    const { guidance } = this.deps
    const existing = quietly(() => guidance.doc(target.id))
    if (existing && existing.kind !== kind) throw invalid('id', `already used by the ${existing.kind} ${target.id}`)
    const body = target.body
    const input = {
      kind,
      projectId: text(body.projectId) || null,
      title: text(body.title),
      summary: text(body.summary),
      body: text(body.body),
      docIds: list(body.docIds),
      docRefs: list(body.docRefs),
    }
    return {
      commit: (by) => {
        if (existing) guidance.updateDoc(target.id, input, by)
        else guidance.createDoc({ ...input, id: target.id }, by)
      },
    }
  }

  /** Corpo vazio apaga o complemento (a regra de `setProtocolAddendum`). */
  private protocol(id: string, body: string): IPreparedWrite {
    const key = parseProtocolItemId(id)
    if (!key) throw invalid('id', `not a protocol addendum: ${id}`)
    return { commit: (by) => this.deps.guidance.setProtocolAddendum(key.kind, key.projectId ?? null, body, by) }
  }

  // --- Projeto ------------------------------------------------------------------------------------------------------

  private project(target: ICatalogDocument): IPreparedWrite {
    const projects = this.requireProjects()
    const body = target.body
    const initialContext = list(body.initialContext)
    const issues = this.deps.guidance.contextIssues(target.id, initialContext)
    if (issues.length) throw new CatalogRestoreInvalidError(issues)
    const exists = projects.exists(target.id)
    const change = { name: text(body.name), description: text(body.description) }
    return {
      commit: (by) => {
        if (exists) projects.update(target.id, change, by)
        else projects.create({ id: target.id, ...change }, by)
        this.deps.guidance.setInitialContext(target.id, initialContext, by)
      },
    }
  }

  private projectPermissions(target: ICatalogDocument): IPreparedWrite {
    if (!this.requireProjects().exists(target.id)) throw invalid('projectId', `no such project: ${target.id} (restore the project first)`)
    const rules = (target.body.rules ?? []) as unknown as IPermissionRule[]
    return { commit: (by) => this.deps.permissions.saveProjectRules(target.id, rules, by) }
  }

  private requireProjects(): NonNullable<ICatalogWriterDeps['projects']> {
    if (!this.deps.projects) throw invalid('projectId', 'projects are not enabled')
    return this.deps.projects
  }

  // --- MCP ----------------------------------------------------------------------------------------------------------

  private mcp(target: ICatalogDocument): IPreparedWrite {
    const { mcps } = this.deps
    const body = target.body
    const projectId = text(body.projectId) || undefined
    const key = mcpServerKey({ id: target.id, projectId })
    const existing = mcps.list().find((server) => mcpServerKey(server) === key)
    const kind = (text(body.kind) || 'remote') as TMcpKind
    if (existing && existing.kind !== kind)
      throw invalid('kind', `the server is now "${existing.kind}" and the version is "${kind}": delete it and restore the version to change the kind`)
    const container = body.container as unknown as IMcpContainer | undefined
    const proc = body.process as unknown as IMcpProcess | undefined
    const change = {
      name: text(body.name),
      url: text(body.url),
      transport: (text(body.transport) || 'auto') as TMcpTransport,
      auth: (text(body.auth) || 'none') as TMcpAuth,
      // Vazio limpa (ausente manteria o de agora).
      headerName: text(body.headerName),
      identity: body.identity === true,
      ...(container ? { container } : {}),
      ...(proc ? { process: proc } : {}),
    }
    const enabled = body.enabled === true
    let saved: IMcpServerConfig | undefined
    return {
      commit: (by) => {
        if (existing) {
          saved = mcps.update(key, { ...change, enabled }, by)
          return
        }
        // Nasce ligado (a regra do cadastro); a versão desligada volta desligada.
        saved = mcps.create({ id: target.id, ...(projectId ? { projectId } : {}), kind, ...change, headerName: change.headerName || undefined }, by)
        if (!enabled) saved = mcps.update(key, { enabled: false }, by)
      },
      after: async () => {
        if (existing && saved) await this.deps.mcpChanged?.(saved)
      },
      missingSecrets: () => {
        const env = mcps.envStatus(key)
        return list(body.secrets).filter((ref) => (ref === 'header' ? !mcps.secretStatus(key).configured : !env.some((item) => `env:${item.name}` === ref && item.configured)))
      },
    }
  }

  private removeMcp(current: ICatalogDocument): IPreparedWrite {
    const key = mcpServerKey({ id: current.id, projectId: current.projectId })
    const server = this.deps.mcps.list().find((item) => mcpServerKey(item) === key)
    return {
      commit: (by) => {
        if (server) this.deps.mcps.remove(key, by)
      },
      after: async () => {
        if (server) await this.deps.mcpRemoved?.(server)
      },
    }
  }
}
