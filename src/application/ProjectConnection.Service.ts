import type { TCatalogScope } from '@application/Catalog.Reader'
import type { CatalogImportApplier } from '@application/CatalogImport.Apply'
import { CATALOG_KINDS, ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { itemRef, parsePackage } from '@domain/Catalog.Import'
import { forLocal, ILocalModels } from '@domain/Connect.Policy'
import { ProjectConnectionError } from '@domain/errors/Domain.Error'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { IConnectionChange, IConnectionSkipped, IProjectConnection } from '@domain/models/ProjectConnection.Model'
import type { IProjectConnectionRepository, TConnectionPatch } from '@domain/ports/ProjectConnectionRepository.Port'
import { IRemoteCatalog, IRemoteChanges, RemoteUnauthorizedError } from '@domain/ports/RemoteCatalog.Port'

/** De quanto em quanto tempo o vigia confere a versão quando o aviso ao vivo caiu (e, de todo modo, de vez em quando). */
export const CONNECTION_POLL_MS = 5 * 60_000
/** A espera para reabrir o aviso ao vivo: começa curta e dobra até o teto. */
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
/** Quantas vezes o plano é refeito tirando o que não entra (o que dependia do que saiu também pode sair). */
const PLAN_ROUNDS = 3

/** A ordem de apagar o que sumiu na origem: quem referencia antes de quem é referenciado. O projeto e as permissões dele nunca. */
const REMOVAL_ORDER: readonly TCatalogKind[] = [...CATALOG_KINDS].reverse().filter((kind) => kind !== 'project' && kind !== 'project-permissions')

export interface IProjectConnectionDeps {
  repository: IProjectConnectionRepository
  /** O cofre do token (`SecretBox`). */
  box: { seal(plain: string, owner: string): string; open(box: string, owner: string): string | undefined }
  client: (url: string, remoteProjectId: string, token: string) => IRemoteCatalog
  projects: { exists(id: string): boolean; create(input: { id: string; name: string; description?: string }, by: string, source: 'api', creatorId?: string): unknown }
  files: { has(sha256: string): boolean; put(content: Buffer): { sha256: string } }
  applier: Pick<CatalogImportApplier, 'plan' | 'apply'>
  reader: { list(scope: TCatalogScope): ICatalogDocument[] }
  /** Apaga um item que sumiu na origem (o escritor do catálogo, com a revisão). */
  remove(current: ICatalogDocument, by: string): Promise<void>
  /** Os modelos desta instalação (sem o mapa, que é da conexão). */
  models(): Promise<Omit<ILocalModels, 'map'>>
  now?: () => Date
}

/** O que a sincronização fez. */
export interface ISyncResult {
  version: number
  applied: number
  removed: string[]
  skipped: IConnectionSkipped[]
}

const owner = (projectId: string) => `connect:${projectId}`

/**
 * 🔌 O PROJETO CONECTADO, do lado do dev: o projeto local é a cópia SÓ DE LEITURA do projeto da origem (a .4).
 *
 * ⚖️ UM AVISO SÓ, SEMPRE PARA A ÚLTIMA: o vigia guarda a última versão da origem e o que mudou desde a daqui; atualizar
 * baixa o pacote da última versão e aplica EM ESPELHO (cria, atualiza e apaga o que sumiu) — nunca versão a versão.
 *
 * ⚖️ O QUE É DA MÁQUINA FICA: os valores das variáveis (o cofre daqui), os modelos (ver `Connect.Policy`) e o resto do
 * catálogo local. O que a origem tem e não entra aqui (o plano recusa) fica listado em `skipped`, com o porquê.
 */
export class ProjectConnectionService {
  private readonly now: () => Date
  private readonly syncing = new Set<string>()
  private watching?: { abort: AbortController; timer: NodeJS.Timeout }
  /** Os projetos com o aviso ao vivo aberto (um vigia por projeto). */
  private readonly watched = new Set<string>()

  constructor(private readonly deps: IProjectConnectionDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  list(): IProjectConnection[] {
    return this.deps.repository.list()
  }

  get(projectId: string): IProjectConnection | undefined {
    return this.deps.repository.get(projectId)
  }

  isConnected(projectId: string): boolean {
    return !!this.deps.repository.get(projectId)
  }

  /**
   * Conecta: confere o token na origem ANTES de criar qualquer coisa, cria o projeto local (quem conecta é o admin dele)
   * e sincroniza a última versão.
   */
  async connect(input: { url: string; projectId: string; token: string }, by: { email: string; userId?: string }): Promise<IProjectConnection> {
    // ⚖️ O MESMO id da origem: os documentos levam o projeto dentro (o agente, a regra), e trocar seria reescrever todos.
    const projectId = input.projectId.trim()
    const remoteProjectId = projectId
    const token = input.token.trim()
    const url = input.url.trim()
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new ProjectConnectionError('invalid', `invalid project id: ${projectId}`)
    if (!/^https?:\/\//i.test(url)) throw new ProjectConnectionError('invalid', 'the url must start with http:// or https://')
    if (this.deps.projects.exists(projectId)) throw new ProjectConnectionError('exists', `a project ${projectId} already exists here: pick another id`)

    const client = this.deps.client(url, remoteProjectId, token)
    try {
      await client.version()
    } catch (error) {
      throw new ProjectConnectionError(error instanceof RemoteUnauthorizedError ? 'unauthorized' : 'unavailable', error instanceof Error ? error.message : String(error))
    }

    this.deps.projects.create({ id: projectId, name: projectId, description: `Conectado a ${url} (projeto ${remoteProjectId}): só leitura.` }, by.email, 'api', by.userId)
    this.deps.repository.insert(
      {
        projectId,
        url,
        remoteProjectId,
        syncedVersion: 0,
        latestVersion: 0,
        state: 'ok',
        changes: [],
        skipped: [],
        secrets: [],
        modelMap: {},
        createdAt: this.now(),
        createdBy: by.email,
      },
      this.deps.box.seal(token, owner(projectId)),
    )
    await this.sync(projectId, by.email)
    return this.require(projectId)
  }

  /** Troca o token (o antigo venceu ou foi revogado) e confere de novo. */
  async replaceToken(projectId: string, token: string): Promise<IProjectConnection> {
    this.require(projectId)
    this.deps.repository.update(projectId, { tokenSealed: this.deps.box.seal(token.trim(), owner(projectId)) })
    await this.check(projectId)
    // O vigia parou quando o token caiu: com o novo, volta a ouvir.
    this.follow(projectId)
    return this.require(projectId)
  }

  /** O mapa de modelos da conexão (`provider/modelo` da origem → daqui). Vale na próxima sincronização. */
  setModelMap(projectId: string, map: Record<string, string>): IProjectConnection {
    this.require(projectId)
    this.deps.repository.update(projectId, { modelMap: map })
    return this.require(projectId)
  }

  /** Desconecta: o projeto fica, como um projeto comum daqui (editável), e o token é esquecido. */
  disconnect(projectId: string): void {
    this.require(projectId)
    this.deps.repository.remove(projectId)
  }

  /** Pergunta à origem a versão e o que mudou desde a daqui: o aviso. */
  async check(projectId: string): Promise<IProjectConnection> {
    const connection = this.require(projectId)
    const result = await this.talk(projectId, (client) => client.changes(connection.syncedVersion))
    if (result) this.deps.repository.update(projectId, { ...this.notice(connection.syncedVersion, result), lastCheckedAt: this.now() })
    return this.require(projectId)
  }

  /** Atualiza para a ÚLTIMA versão da origem, em espelho. */
  async sync(projectId: string, by: string): Promise<ISyncResult> {
    if (this.syncing.has(projectId)) throw new ProjectConnectionError('busy', `${projectId} is already updating`)
    this.syncing.add(projectId)
    try {
      return await this.mirror(projectId, by)
    } finally {
      this.syncing.delete(projectId)
    }
  }

  /** O vigia: o aviso ao vivo de cada conexão (reabre com espera crescente) e uma conferência periódica de todas. */
  start(): void {
    if (this.watching) return
    const abort = new AbortController()
    const timer = setInterval(() => void this.checkAll(), CONNECTION_POLL_MS)
    timer.unref?.()
    this.watching = { abort, timer }
    void this.checkAll()
    for (const connection of this.list()) void this.watch(connection.projectId, abort.signal)
  }

  stop(): void {
    this.watching?.abort.abort()
    if (this.watching) clearInterval(this.watching.timer)
    this.watching = undefined
  }

  /** Começa a vigiar uma conexão nova (o `start` só pega as que já existiam). */
  follow(projectId: string): void {
    if (this.watching) void this.watch(projectId, this.watching.abort.signal)
  }

  private async checkAll(): Promise<void> {
    for (const connection of this.list()) await this.check(connection.projectId).catch(() => undefined)
  }

  private async watch(projectId: string, signal: AbortSignal): Promise<void> {
    if (this.watched.has(projectId)) return
    this.watched.add(projectId)
    try {
      await this.listen(projectId, signal)
    } finally {
      this.watched.delete(projectId)
    }
  }

  /** O aviso ao vivo de um projeto, reabrindo com espera crescente; token que caiu para (até o `replaceToken`). */
  private async listen(projectId: string, signal: AbortSignal): Promise<void> {
    let wait = RETRY_MIN_MS
    while (!signal.aborted && this.deps.repository.get(projectId)) {
      const client = this.clientOf(projectId)
      try {
        await client?.events((version) => {
          wait = RETRY_MIN_MS
          const current = this.deps.repository.get(projectId)
          if (current && version > current.latestVersion) void this.check(projectId).catch(() => undefined)
        }, signal)
      } catch (error) {
        if (error instanceof RemoteUnauthorizedError) {
          this.deps.repository.update(projectId, { state: 'unauthorized', lastError: error.message })
          return
        }
      }
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.())
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
  }

  private async mirror(projectId: string, by: string): Promise<ISyncResult> {
    const connection = this.require(projectId)
    const pack = await this.talk(projectId, (client) => client.package(connection.syncedVersion))
    if (!pack)
      throw new ProjectConnectionError(
        this.require(projectId).state === 'unauthorized' ? 'unauthorized' : 'unavailable',
        this.require(projectId).lastError ?? 'the origin did not answer',
      )

    // Os arquivos que faltam aqui, antes de gravar quem os cita (o escritor recusa conteúdo que não está no cofre).
    const client = this.clientOf(projectId)!
    for (const file of pack.files) {
      if (this.deps.files.has(file.sha256)) continue
      const content = await client.file(file.sha256)
      if (this.deps.files.put(content).sha256 !== file.sha256) throw new ProjectConnectionError('unavailable', `the file ${file.sha256} came corrupted`)
    }

    const models = { ...(await this.deps.models()), map: connection.modelMap }
    const parsed = parsePackage(pack.package.files, pack.package.manifest)
    let documents = parsed.documents.map((document) => forLocal(document, models))
    const scope: TCatalogScope = { kind: 'project', projectId }
    const skipped: IConnectionSkipped[] = parsed.errors.map((error) => ({ ref: error.path, message: error.message }))

    // O que não entra sai do lote, com o motivo; o resto entra (o que dependia do que saiu cai na rodada seguinte).
    let planned = await this.deps.applier.plan({ documents, scope })
    for (let round = 0; round < PLAN_ROUNDS; round++) {
      const blocked = planned.plan.items.filter((item) => item.op === 'error' || item.op === 'conflict')
      if (!blocked.length) break
      for (const item of blocked) skipped.push({ ref: item.ref, message: item.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ') || item.op })
      const out = new Set(blocked.map((item) => item.ref))
      documents = documents.filter((document) => !out.has(itemRef(document.kind, document.id, document.projectId)))
      planned = await this.deps.applier.plan({ documents, scope })
    }

    const who = `conexão ${connection.url} (${by})`
    const result = await this.deps.applier.apply(
      {
        documents,
        scope,
        planHash: planned.plan.planHash,
        confirm: planned.plan.widenings.map((widening) => widening.key),
        provenance: { connection: connection.url, version: pack.version },
      },
      { by: who, viaAccessToken: false, administers: () => true },
    )
    if (result.failed) skipped.push({ ref: result.failed.ref, message: result.failed.message })

    // O espelho: o que o projeto tem aqui e a origem não tem mais.
    const kept = new Set(parsed.documents.map((document) => `${document.kind}/${document.id}`))
    const removed: string[] = []
    const local = this.deps.reader.list(scope)
    for (const kind of REMOVAL_ORDER)
      for (const current of local.filter((document) => document.kind === kind && !kept.has(`${document.kind}/${document.id}`)))
        try {
          await this.deps.remove(current, who)
          removed.push(`${current.kind}/${current.id}`)
        } catch (error) {
          skipped.push({ ref: `${current.kind}/${current.id}`, message: `could not remove: ${error instanceof Error ? error.message : String(error)}` })
        }

    const latest = Math.max(this.require(projectId).latestVersion, pack.version)
    this.deps.repository.update(projectId, {
      syncedVersion: pack.version,
      latestVersion: latest,
      changes: [],
      changesTruncated: false,
      skipped,
      secrets: pack.secrets,
      lastSyncedAt: this.now(),
      lastCheckedAt: this.now(),
    })
    // Mudou na origem enquanto atualizava: o aviso volta, já para a nova última.
    if (latest > pack.version) await this.check(projectId).catch(() => undefined)
    return { version: pack.version, applied: result.applied.length, removed, skipped }
  }

  /** O aviso a partir da resposta da origem: a última versão e as mudanças desde a daqui. */
  private notice(synced: number, result: IRemoteChanges): TConnectionPatch {
    const changes: IConnectionChange[] = result.version > synced ? result.changes : []
    return { latestVersion: result.version, changes, changesTruncated: !!result.truncated && changes.length > 0, state: 'ok', lastError: undefined }
  }

  /** Uma conversa com a origem: o estado da conexão acompanha (fora do ar, token que não vale). */
  private async talk<T>(projectId: string, work: (client: IRemoteCatalog) => Promise<T>): Promise<T | undefined> {
    const client = this.clientOf(projectId)
    if (!client) {
      this.deps.repository.update(projectId, { state: 'unauthorized', lastError: 'the stored token could not be opened: connect again' })
      return undefined
    }
    try {
      return await work(client)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.repository.update(projectId, { state: error instanceof RemoteUnauthorizedError ? 'unauthorized' : 'offline', lastError: message, lastCheckedAt: this.now() })
      return undefined
    }
  }

  private clientOf(projectId: string): IRemoteCatalog | undefined {
    const connection = this.deps.repository.get(projectId)
    const sealed = this.deps.repository.tokenSealed(projectId)
    const token = connection && sealed ? this.deps.box.open(sealed, owner(projectId)) : undefined
    return connection && token ? this.deps.client(connection.url, connection.remoteProjectId, token) : undefined
  }

  private require(projectId: string): IProjectConnection {
    const connection = this.deps.repository.get(projectId)
    if (!connection) throw new ProjectConnectionError('not_found', `${projectId} is not a connected project`)
    return connection
  }
}
