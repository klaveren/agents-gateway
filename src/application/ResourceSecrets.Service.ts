import { InvalidGuidanceError } from '@domain/errors/Domain.Error'
import { IAmbientSecrets } from '@domain/Ambient.Policy'
import {
  effectiveSources,
  ILoadedResource,
  IResourceSecretMeta,
  IResourceSecretView,
  ISecretSource,
  ORIGIN_PROJECT,
  SECRET_LIMITS,
  secretNameIssue,
  TSecretScope,
} from '@domain/models/ResourceSecret.Model'
import type { IKnownSecret } from '@domain/Secret.Mask'

/** Onde as variáveis moram (o `SqliteResourceSecretRepository`). */
export interface IResourceSecretStore {
  list(scope: TSecretScope, scopeId: string, project?: string): IResourceSecretMeta[]
  value(scope: TSecretScope, scopeId: string, name: string, project?: string): string | undefined
  save(input: { scope: TSecretScope; scopeId: string; project?: string; name: string; description?: string; value?: string; by: string; at: Date }): boolean
  remove(scope: TSecretScope, scopeId: string, name: string, project?: string): boolean
  removeScope(scope: TSecretScope, scopeId: string): void
  keepProjects(scope: TSecretScope, scopeId: string, keep: readonly string[]): void
  removeProject(project: string): void
}

export interface IResourceSecretsDeps {
  store: IResourceSecretStore
  /** O recurso existe e é deste tipo (`skill`/`command`); o agente existe. */
  exists(scope: TSecretScope, scopeId: string): boolean
  /** A máscara da conversa: o valor entregue a um processo passa a ser trocado em tudo o que a conversa mostra e grava. */
  /** O projeto do agente (`null` = global; `undefined` = não existe). Ausente: tudo vale como origem. */
  agentProject?(agentId: string): string | null | undefined
  /** O projeto dono da skill ou do command (`null` = global; `undefined` = não existe). Ausente: tudo vale como origem. */
  resourceProject?(id: string): string | null | undefined
  mask?: { register(sessionId: string, secrets: readonly IKnownSecret[]): void }
  now?: () => Date
}

/** O ambiente secreto de um processo agora: as variáveis (com valor) e de onde veio cada uma. */
export interface ISecretEnv {
  env: Record<string, string>
  sources: ISecretSource[]
}

/** Conversas lembradas (o que cada uma carregou): acima disto, a mais antiga sai. */
const SESSIONS_KEPT = 5_000

/**
 * As variáveis secretas dos agentes, skills e commands (ver `ResourceSecret.Model`). ⛔ O valor só sai por `envFor`, para o
 * ambiente de um processo — e, saindo, entra na máscara da conversa.
 *
 * ⚖️ O QUE A CONVERSA CARREGOU fica em memória: depois de um reinício, a skill é carregada de novo (e a variável dela volta).
 */
export class ResourceSecretsService {
  private readonly loaded = new Map<string, ILoadedResource[]>()
  private readonly now: () => Date

  constructor(private readonly deps: IResourceSecretsDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * As variáveis de um projeto (`ORIGIN_PROJECT` = a origem). Para um projeto que RECEBEU o recurso, ainda soma os nomes
   * que a origem usa e ele não configurou (`configured: false`): a tela mostra o que falta. Nunca o valor.
   */
  list(scope: TSecretScope, scopeId: string, project: string = ORIGIN_PROJECT): IResourceSecretView[] {
    const own: IResourceSecretView[] = this.deps.store.list(scope, scopeId, project).map((item) => ({ ...item, configured: true }))
    if (project === ORIGIN_PROJECT) return own
    const have = new Set(own.map((item) => item.name))
    const expected = this.deps.store
      .list(scope, scopeId, ORIGIN_PROJECT)
      .filter((item) => !have.has(item.name))
      .map<IResourceSecretView>(({ scope, scopeId, name, description }) => ({ scope, scopeId, name, ...(description ? { description } : {}), configured: false }))
    return [...own, ...expected].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Grava a variável: o valor (que só entra) e a descrição. Sem `value`, só a descrição (a variável já existe). */
  save(scope: TSecretScope, scopeId: string, input: { name: string; description?: string; value?: string }, by: string, project: string = ORIGIN_PROJECT): IResourceSecretView {
    const name = input.name.trim()
    const issues: Array<{ field: string; message: string }> = []
    if (!this.deps.exists(scope, scopeId)) issues.push({ field: 'scope', message: `${scope} not found: ${scopeId}` })
    const nameIssue = secretNameIssue(name)
    if (nameIssue) issues.push({ field: 'name', message: nameIssue })
    if ((input.description?.length ?? 0) > SECRET_LIMITS.description) issues.push({ field: 'description', message: `up to ${SECRET_LIMITS.description} characters` })
    const current = this.deps.store.list(scope, scopeId, project)
    const exists = current.some((item) => item.name === name)
    if (input.value !== undefined && !input.value.trim()) issues.push({ field: 'value', message: 'required (empty does not clear: delete the variable)' })
    if ((input.value?.length ?? 0) > SECRET_LIMITS.value) issues.push({ field: 'value', message: 'too large' })
    if (input.value === undefined && !exists) issues.push({ field: 'value', message: 'required for a new variable' })
    if (!exists && current.length >= SECRET_LIMITS.perScope) issues.push({ field: 'name', message: `at most ${SECRET_LIMITS.perScope} variables per ${scope}` })
    if (issues.length) throw new InvalidGuidanceError(issues)
    this.deps.store.save({
      scope,
      scopeId,
      project,
      name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      by,
      at: this.now(),
    })
    return { ...this.deps.store.list(scope, scopeId, project).find((item) => item.name === name)!, configured: true }
  }

  remove(scope: TSecretScope, scopeId: string, name: string, project: string = ORIGIN_PROJECT): boolean {
    return this.deps.store.remove(scope, scopeId, name, project)
  }

  /** O recurso foi apagado: somem os valores da origem e os de todo projeto. */
  removeScope(scope: TSecretScope, scopeId: string): void {
    this.deps.store.removeScope(scope, scopeId)
  }

  /**
   * ⛔ A lista de projetos com que o recurso é compartilhado mudou (ou ele mudou de dono): quem saiu perde os valores que
   * configurou — parar de compartilhar apaga, não esconde (compartilhar de novo começa em branco, nunca revive um segredo velho).
   */
  keepProjects(id: string, projects: readonly string[]): void {
    for (const scope of ['skill', 'command'] as const) this.deps.store.keepProjects(scope, id, projects)
  }

  /** O projeto foi apagado: os valores dele somem. */
  removeProject(project: string): void {
    this.deps.store.removeProject(project)
  }

  /** A skill ou o command entrou na conversa (`use_resource`, `/skill`, `/command`): as variáveis dele passam a valer nela. */
  markLoaded(sessionId: string | undefined, kind: 'skill' | 'command', id: string): void {
    if (!sessionId) return
    const list = (this.loaded.get(sessionId) ?? []).filter((item) => !(item.kind === kind && item.id === id))
    list.push({ kind, id })
    this.loaded.delete(sessionId)
    this.loaded.set(sessionId, list)
    if (this.loaded.size > SESSIONS_KEPT) this.loaded.delete(this.loaded.keys().next().value!)
  }

  /** As variáveis que valem agora para o agente nesta conversa, só os nomes e de onde vêm. */
  sources(agentId: string | undefined, sessionId: string | undefined): ISecretSource[] {
    const named = (scope: TSecretScope, scopeId: string, project: string): ISecretSource[] =>
      this.deps.store.list(scope, scopeId, project).map((item) => ({ name: item.name, scope, scopeId, project }))
    const agent = agentId ? named('agent', agentId, ORIGIN_PROJECT) : []
    const loaded = (sessionId ? (this.loaded.get(sessionId) ?? []) : []).map((item) => named(item.kind, item.id, this.projectFor(item.id, agentId)))
    return effectiveSources(agent, loaded)
  }

  /**
   * ⛔ O AMBIENTE SECRETO de um processo: os valores das variáveis que valem agora. O que sai daqui entra na máscara da
   * conversa ANTES de chegar ao processo — a saída dele já nasce mascarada.
   */
  envFor(agentId: string | undefined, sessionId: string | undefined): ISecretEnv {
    const sources = this.sources(agentId, sessionId)
    const env: Record<string, string> = {}
    const known: IKnownSecret[] = []
    for (const source of sources) {
      const value = this.deps.store.value(source.scope, source.scopeId, source.name, source.project ?? ORIGIN_PROJECT)
      if (value === undefined) continue
      env[source.name] = value
      known.push({ value, label: source.name })
    }
    if (sessionId && known.length) this.deps.mask?.register(sessionId, known)
    return { env, sources: sources.filter((source) => source.name in env) }
  }

  /**
   * ⛔ De quem são os valores de um recurso para este agente: agente do projeto dono (ou recurso global) usa os da origem;
   * agente de OUTRO projeto (que recebeu o recurso por compartilhamento) usa os do projeto dele — nunca os da origem.
   */
  private projectFor(resourceId: string, agentId: string | undefined): string {
    const owner = this.deps.resourceProject?.(resourceId)
    const mine = agentId ? this.deps.agentProject?.(agentId) : undefined
    return owner && mine && owner !== mine ? mine : ORIGIN_PROJECT
  }

  /** O que o prompt diz ao agente: os nomes dele e os das skills e commands que ele pode carregar. Nunca o valor. */
  ambientFor(agentId: string, usable: ReadonlyArray<{ kind: 'skill' | 'command'; id: string }>): IAmbientSecrets | undefined {
    const agent = this.deps.store.list('agent', agentId, ORIGIN_PROJECT).map((item) => item.name)
    const resources = usable
      .map((resource) => ({ ...resource, names: this.deps.store.list(resource.kind, resource.id, this.projectFor(resource.id, agentId)).map((item) => item.name) }))
      .filter((resource) => resource.names.length)
    return agent.length || resources.length ? { agent, resources } : undefined
  }
}
