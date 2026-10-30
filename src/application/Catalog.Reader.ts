import {
  agentDocument,
  CATALOG_KINDS,
  docDocument,
  ICatalogDocument,
  mcpDocument,
  parseProtocolItemId,
  projectDocument,
  projectPermissionsDocument,
  protocolDocument,
  resourceDocument,
  ruleDocument,
  TCatalogKind,
} from '@domain/Catalog.Document'
import { IAgent } from '@domain/models/Agent.Model'
import { DOC_KINDS } from '@domain/models/ProjectDoc.Model'
import { PROTOCOL_KINDS } from '@domain/models/Protocol.Model'
import { effectiveResources, RESOURCE_KINDS } from '@domain/models/Resource.Model'
import { IAgentRepository } from '@domain/ports/AgentRepository.Port'
import { IGuidanceRepository, TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'
import { mcpServerKey } from '@domain/models/McpServer.Model'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { IPermissionRepository } from '@domain/ports/PermissionRepository.Port'
import { IProjectRepository } from '@domain/ports/ProjectRepository.Port'

/**
 * O escopo de uma leitura:
 * - `all`: tudo — os globais, todos os projetos e os MCPs;
 * - `global`: só o que não é de projeto, e os MCPs (são do sistema);
 * - `project`: só o projeto — os itens dele, o próprio projeto e as permissões dele. ⛔ Nada de outro projeto, nem os
 *   globais (o export de projeto só leva o projeto).
 */
export type TCatalogScope = { kind: 'all' } | { kind: 'global' } | { kind: 'project'; projectId: string }

export interface ICatalogReaderDeps {
  agents: IAgentRepository
  guidance: IGuidanceRepository
  permissions: IPermissionRepository
  mcps: IMcpServerRepository
  projects: IProjectRepository
}

/**
 * O LEITOR DO CATÁLOGO: monta o documento canônico (`Catalog.Document`) de cada item, juntando os repositórios — o
 * agente vem de `agents` e os vínculos dele de `agent_resources`/`agent_context_docs`, que moram noutro repositório.
 *
 * ⛔ SÓ LEITURA. ⚖️ Lê o que está GRAVADO, não o que vale agora: os modelos desligados no catálogo continuam no agente,
 * e o contexto inicial sai como está, sem filtrar doc inexistente — o histórico e o export precisam do registro, não da
 * visão do turno.
 */
export class CatalogReader {
  constructor(private readonly deps: ICatalogReaderDeps) {}

  /**
   * O documento de `(kind, id)`; `undefined` se não existe. `projectId` só desambigua o MCP (o mesmo id pode existir em
   * dois projetos); os outros tipos têm id único no gateway.
   */
  read(kind: TCatalogKind, id: string, projectId?: string): ICatalogDocument | undefined {
    const { guidance, projects, mcps, permissions } = this.deps
    switch (kind) {
      case 'agent': {
        const agent = this.deps.agents.list().find((item) => item.id === id)
        return agent ? this.agent(agent) : undefined
      }
      case 'skill':
      case 'command': {
        const resource = guidance.resource(id)
        return resource?.kind === kind ? resourceDocument(resource) : undefined
      }
      case 'rule': {
        const rule = guidance.rule(id)
        return rule ? ruleDocument(rule) : undefined
      }
      case 'spec':
      case 'adr':
      case 'knowledge': {
        const doc = guidance.doc(id)
        return doc?.kind === kind ? docDocument(doc) : undefined
      }
      case 'protocol': {
        const key = parseProtocolItemId(id)
        if (!key || (key.projectId && !projects.get(key.projectId))) return undefined
        const addendum = guidance.protocolAddendum(key.kind, key.projectId ?? null)
        return addendum ? protocolDocument(addendum) : undefined
      }
      case 'project': {
        const project = projects.get(id)
        return project ? projectDocument(project, guidance.contextDocs(id)) : undefined
      }
      case 'project-permissions':
        return projects.get(id) ? projectPermissionsDocument(id, permissions.projectRules(id).rules) : undefined
      case 'mcp': {
        const server = mcps.get(mcpServerKey({ id, projectId }))
        return server ? mcpDocument(server) : undefined
      }
    }
  }

  /** Os documentos do escopo, pelo tipo (`CATALOG_KINDS`) e depois pelo id. */
  list(scope: TCatalogScope): ICatalogDocument[] {
    const { guidance, projects, mcps, permissions } = this.deps
    const projectIds = scope.kind === 'project' ? (projects.get(scope.projectId) ? [scope.projectId] : []) : projects.list().map((project) => project.id)
    const scopes: TGuidanceScope[] = scope.kind === 'project' ? projectIds : scope.kind === 'global' ? [null] : [null, ...projectIds]
    const withProjects = scope.kind !== 'global'

    const documents: ICatalogDocument[] = []
    if (withProjects) {
      for (const projectId of projectIds) {
        documents.push(projectDocument(projects.get(projectId)!, guidance.contextDocs(projectId)))
        documents.push(projectPermissionsDocument(projectId, permissions.projectRules(projectId).rules))
      }
    }
    for (const guidanceScope of scopes) {
      for (const kind of DOC_KINDS) documents.push(...guidance.docs(guidanceScope, kind).map(docDocument))
      for (const kind of RESOURCE_KINDS) documents.push(...guidance.resources(guidanceScope, kind).map(resourceDocument))
      documents.push(...guidance.rules(guidanceScope).map(ruleDocument))
      for (const kind of PROTOCOL_KINDS) {
        const addendum = guidance.protocolAddendum(kind, guidanceScope)
        if (addendum) documents.push(protocolDocument(addendum))
      }
    }
    const inScope = (item: { projectId?: string }) => (scope.kind === 'all' ? true : scope.kind === 'global' ? !item.projectId : item.projectId === scope.projectId)
    // ⛔ MCP de projeto sai no escopo do projeto dele, nunca no global nem no de outro projeto.
    documents.push(...mcps.list().filter(inScope).map(mcpDocument))
    documents.push(
      ...this.deps.agents
        .list()
        .filter(inScope)
        .map((agent) => this.agent(agent)),
    )

    const order = (kind: TCatalogKind) => CATALOG_KINDS.indexOf(kind)
    return documents.sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private agent(agent: IAgent): ICatalogDocument {
    const { guidance } = this.deps
    return agentDocument(agent, { resources: effectiveResources(guidance.agentResources(agent.id)), initialContext: guidance.agentContextDocs(agent.id) })
  }
}
