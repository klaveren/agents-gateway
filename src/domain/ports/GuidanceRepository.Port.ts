import { IProjectDoc, TDocKind } from '@domain/models/ProjectDoc.Model'
import { IProtocolAddendum, TProtocolKind } from '@domain/models/Protocol.Model'
import { IAgentResources, IResource, TResourceKind } from '@domain/models/Resource.Model'
import { IRule } from '@domain/models/Rule.Model'

/** Um escopo: `null` = global; texto = o id do projeto. */
export type TGuidanceScope = string | null

/** `projectId: null` move para o global. */
export type TRulePatch = Partial<Pick<IRule, 'title' | 'body' | 'enabled' | 'position' | 'updatedAt' | 'updatedBy'>> & { projectId?: string | null }
export type TDocPatch = Partial<Pick<IProjectDoc, 'kind' | 'title' | 'summary' | 'body' | 'updatedAt' | 'updatedBy'>> & { projectId?: string | null }

/** Um documento achado pela busca de texto: sem o corpo, com o trecho que casou (entre « »). */
export interface IDocHit {
  id: string
  kind: TDocKind
  projectId?: string
  title: string
  summary: string
  excerpt: string
}

/** As rules e os documentos (specs e ADRs). Síncrono, como o resto do cadastro. */
export interface IGuidanceRepository {
  /** As do escopo, pela posição. */
  rules(scope: TGuidanceScope): IRule[]
  rule(id: string): IRule | undefined
  insertRule(rule: IRule): void
  updateRule(id: string, patch: TRulePatch): IRule | undefined
  deleteRule(id: string): boolean

  /** Os do escopo, pelo tipo e pelo título. */
  docs(scope: TGuidanceScope, kind?: TDocKind): IProjectDoc[]
  doc(id: string): IProjectDoc | undefined
  insertDoc(doc: IProjectDoc): void
  updateDoc(id: string, patch: TDocPatch): IProjectDoc | undefined
  deleteDoc(id: string): boolean
  /** A busca de texto (FTS) nos documentos dos escopos, os mais relevantes primeiro. `match` é a expressão FTS5 pronta. */
  searchDocs(match: string, scopes: readonly TGuidanceScope[], kind?: TDocKind, limit?: number): IDocHit[]

  /** O CONTEXTO INICIAL do projeto: as specs que vão inteiras no prompt, na ordem. */
  contextDocs(projectId: string): string[]
  /** Os projetos que carregam este documento no contexto inicial. */
  contextProjectsOf(docId: string): string[]
  /** Troca a lista inteira. */
  setContextDocs(projectId: string, docIds: readonly string[], by: string): void

  /** O CONTEXTO INICIAL do agente: as specs que ele carrega inteiras além das do projeto, na ordem. */
  agentContextDocs(agentId: string): string[]
  /** Os agentes que carregam este documento no contexto inicial deles. */
  agentContextOf(docId: string): string[]
  setAgentContextDocs(agentId: string, docIds: readonly string[], by: string): void
  /** O agente foi apagado: a lista dele vai junto. */
  deleteAgentContext(agentId: string): void

  /** Os recursos (skills e commands) do escopo, pelo id. */
  resources(scope: TGuidanceScope, kind?: TResourceKind): IResource[]
  resource(id: string): IResource | undefined
  /** Grava (cria ou substitui) o recurso inteiro. */
  saveResource(resource: IResource): void
  deleteResource(id: string): boolean
  /** O que o agente pode usar, por tipo (`*` = todos). */
  agentResources(agentId: string): IAgentResources
  setAgentResources(agentId: string, resources: IAgentResources, by: string): void
  deleteAgentResources(agentId: string): void

  /** O complemento do protocolo de um tipo, no escopo. */
  protocolAddendum(kind: TProtocolKind, scope: TGuidanceScope): IProtocolAddendum | undefined
  /** Grava o complemento; `undefined` apaga. */
  setProtocolAddendum(kind: TProtocolKind, scope: TGuidanceScope, addendum: IProtocolAddendum | undefined): void

  /** O projeto foi apagado: as rules, os documentos e o contexto inicial dele vão junto. */
  deleteProject(projectId: string): void
}
