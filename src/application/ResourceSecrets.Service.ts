import { InvalidGuidanceError } from '@domain/errors/Domain.Error'
import { IAmbientSecrets } from '@domain/Ambient.Policy'
import { effectiveSources, ILoadedResource, IResourceSecretMeta, ISecretSource, SECRET_LIMITS, secretNameIssue, TSecretScope } from '@domain/models/ResourceSecret.Model'
import type { IKnownSecret } from '@domain/Secret.Mask'

/** Onde as variáveis moram (o `SqliteResourceSecretRepository`). */
export interface IResourceSecretStore {
  list(scope: TSecretScope, scopeId: string): IResourceSecretMeta[]
  value(scope: TSecretScope, scopeId: string, name: string): string | undefined
  save(input: { scope: TSecretScope; scopeId: string; name: string; description?: string; value?: string; by: string; at: Date }): boolean
  remove(scope: TSecretScope, scopeId: string, name: string): boolean
  removeScope(scope: TSecretScope, scopeId: string): void
}

export interface IResourceSecretsDeps {
  store: IResourceSecretStore
  /** O recurso existe e é deste tipo (`skill`/`command`); o agente existe. */
  exists(scope: TSecretScope, scopeId: string): boolean
  /** A máscara da conversa: o valor entregue a um processo passa a ser trocado em tudo o que a conversa mostra e grava. */
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

  list(scope: TSecretScope, scopeId: string): IResourceSecretMeta[] {
    return this.deps.store.list(scope, scopeId)
  }

  /** Grava a variável: o valor (que só entra) e a descrição. Sem `value`, só a descrição (a variável já existe). */
  save(scope: TSecretScope, scopeId: string, input: { name: string; description?: string; value?: string }, by: string): IResourceSecretMeta {
    const name = input.name.trim()
    const issues: Array<{ field: string; message: string }> = []
    if (!this.deps.exists(scope, scopeId)) issues.push({ field: 'scope', message: `${scope} not found: ${scopeId}` })
    const nameIssue = secretNameIssue(name)
    if (nameIssue) issues.push({ field: 'name', message: nameIssue })
    if ((input.description?.length ?? 0) > SECRET_LIMITS.description) issues.push({ field: 'description', message: `up to ${SECRET_LIMITS.description} characters` })
    const current = this.deps.store.list(scope, scopeId)
    const exists = current.some((item) => item.name === name)
    if (input.value !== undefined && !input.value.trim()) issues.push({ field: 'value', message: 'required (empty does not clear: delete the variable)' })
    if ((input.value?.length ?? 0) > SECRET_LIMITS.value) issues.push({ field: 'value', message: 'too large' })
    if (input.value === undefined && !exists) issues.push({ field: 'value', message: 'required for a new variable' })
    if (!exists && current.length >= SECRET_LIMITS.perScope) issues.push({ field: 'name', message: `at most ${SECRET_LIMITS.perScope} variables per ${scope}` })
    if (issues.length) throw new InvalidGuidanceError(issues)
    this.deps.store.save({
      scope,
      scopeId,
      name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      by,
      at: this.now(),
    })
    return this.deps.store.list(scope, scopeId).find((item) => item.name === name)!
  }

  remove(scope: TSecretScope, scopeId: string, name: string): boolean {
    return this.deps.store.remove(scope, scopeId, name)
  }

  /** O recurso foi apagado. */
  removeScope(scope: TSecretScope, scopeId: string): void {
    this.deps.store.removeScope(scope, scopeId)
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
    const named = (scope: TSecretScope, scopeId: string): ISecretSource[] => this.deps.store.list(scope, scopeId).map((item) => ({ name: item.name, scope, scopeId }))
    const agent = agentId ? named('agent', agentId) : []
    const loaded = (sessionId ? (this.loaded.get(sessionId) ?? []) : []).map((item) => named(item.kind, item.id))
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
      const value = this.deps.store.value(source.scope, source.scopeId, source.name)
      if (value === undefined) continue
      env[source.name] = value
      known.push({ value, label: source.name })
    }
    if (sessionId && known.length) this.deps.mask?.register(sessionId, known)
    return { env, sources: sources.filter((source) => source.name in env) }
  }

  /** O que o prompt diz ao agente: os nomes dele e os das skills e commands que ele pode carregar. Nunca o valor. */
  ambientFor(agentId: string, usable: ReadonlyArray<{ kind: 'skill' | 'command'; id: string }>): IAmbientSecrets | undefined {
    const agent = this.deps.store.list('agent', agentId).map((item) => item.name)
    const resources = usable
      .map((resource) => ({ ...resource, names: this.deps.store.list(resource.kind, resource.id).map((item) => item.name) }))
      .filter((resource) => resource.names.length)
    return agent.length || resources.length ? { agent, resources } : undefined
  }
}
