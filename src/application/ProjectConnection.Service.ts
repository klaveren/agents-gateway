import type { TCatalogScope } from '@application/Catalog.Reader'
import type { CatalogImportApplier } from '@application/CatalogImport.Apply'
import { CATALOG_KINDS, ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { itemRef, parsePackage } from '@domain/Catalog.Import'
import { forLocal, ILocalModels } from '@domain/Connect.Policy'
import { InvalidLedgerError, LedgerQueuedError, ProjectConnectionError } from '@domain/errors/Domain.Error'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { IConnectionChange, IConnectionSkipped, IProjectConnection } from '@domain/models/ProjectConnection.Model'
import type { IProjectConnectionRepository, TConnectionPatch } from '@domain/ports/ProjectConnectionRepository.Port'
import { IRemoteCatalog, IRemoteChanges, RemoteRequestError, RemoteUnauthorizedError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'
import type { ILedgerWrite } from '@domain/models/Ledger.Model'
import type { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'
import { REMOTE_USAGE_MAX_ROWS } from '@domain/models/RemoteUsage.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'

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
  /** O uso das conversas daqui (as linhas do relatório), para mandar o do projeto conectado à origem. */
  usage?: (query: IUsageQuery) => Promise<IUsageRow[]>
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
  /** O último ledger lido da origem, por agente e pergunta: o que o agente lê quando a origem está fora do ar. */
  private readonly ledgerCache = new Map<string, unknown>()
  /** A seção do ledger no system prompt de cada agente conectado (a última que a origem deu). */
  private readonly prompts = new Map<string, string | null>()
  private readonly flushing = new Set<string>()

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
    if (result) {
      this.deps.repository.update(projectId, { ...this.notice(connection.syncedVersion, result), lastCheckedAt: this.now() })
      // A origem respondeu: a fila do ledger sai agora.
      await this.flushLedger(projectId).catch(() => undefined)
    }
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

  /**
   * 🔌 O LEDGER DE UM AGENTE DE PROJETO CONECTADO: mora na ORIGEM (um ledger só, não um por máquina). Ler vai lá e guarda
   * a resposta; com a origem fora do ar, devolve a última lida. Escrever vai lá; fora do ar, entra na FILA, na ordem, e
   * sai quando ela voltar (o vigia esvazia).
   */
  async ledgerRead<T>(projectId: string, agentId: string, ask: 'index' | 'context' | 'search', key = ''): Promise<T> {
    const client = this.clientOf(projectId)
    const cacheKey = `${projectId}\0${agentId}\0${ask}\0${key}`
    try {
      if (!client) throw new RemoteUnavailableError('the stored token could not be opened')
      const ledger = client.ledger(agentId)
      const result = ask === 'index' ? await ledger.index() : ask === 'context' ? await ledger.context(key) : await ledger.search(key)
      this.ledgerCache.set(cacheKey, result)
      if (ask === 'index') this.prompts.set(agentId, (result as { prompt: string | null }).prompt)
      return result as T
    } catch (error) {
      const cached = this.ledgerCache.get(cacheKey)
      if (error instanceof RemoteRequestError) throw new Error(error.message, { cause: error })
      if (cached !== undefined) return cached as T
      throw new Error(`O ledger mora na origem do projeto, que não respondeu agora (${error instanceof Error ? error.message : String(error)}). Tente de novo mais tarde.`, {
        cause: error,
      })
    }
  }

  async ledgerWrite<T>(projectId: string, agentId: string, change: ILedgerWrite, conversationId?: string): Promise<T> {
    const queue = () => {
      this.deps.repository.enqueueLedger({ projectId, agentId, change, ...(conversationId ? { conversationId } : {}), createdAt: this.now() })
      return new LedgerQueuedError()
    }
    // ⚖️ A ORDEM: com escrita na fila, a nova entra atrás dela (senão passaria na frente).
    if (this.deps.repository.pendingLedger(projectId).length) {
      await this.flushLedger(projectId)
      if (this.deps.repository.pendingLedger(projectId).length) throw queue()
    }
    const client = this.clientOf(projectId)
    if (!client) throw queue()
    try {
      return (await client.ledger(agentId).write(change, conversationId)) as T
    } catch (error) {
      if (error instanceof RemoteRequestError) throw remoteRefusal(error)
      if (error instanceof RemoteUnauthorizedError)
        throw new Error(`O ledger mora na origem do projeto, que recusou a conexão: ${error.message}. Troque o token do projeto.`, { cause: error })
      throw queue()
    }
  }

  /** A seção do ledger no system prompt do agente conectado: a última que a origem deu (lê de novo em segundo plano). */
  ledgerPrompt(projectId: string, agentId: string): string | undefined {
    void this.ledgerRead(projectId, agentId, 'index').catch(() => undefined)
    return this.prompts.get(agentId) ?? undefined
  }

  /** Esvazia a fila do ledger, na ordem; para na primeira que não sai (a origem caiu de novo). Recusa da origem descarta, com o motivo. */
  async flushLedger(projectId: string): Promise<void> {
    if (this.flushing.has(projectId)) return
    this.flushing.add(projectId)
    try {
      const client = this.clientOf(projectId)
      if (!client) return
      for (const entry of this.deps.repository.pendingLedger(projectId)) {
        try {
          await client.ledger(entry.agentId).write(entry.change, entry.conversationId)
        } catch (error) {
          if (!(error instanceof RemoteRequestError)) return
          const skipped = this.require(projectId).skipped
          this.deps.repository.update(projectId, {
            skipped: [...skipped, { ref: `ledger/${entry.agentId}/${entry.change.topic}`, message: `a origem recusou a escrita da fila: ${error.message}` }],
          })
        }
        this.deps.repository.dropLedger(entry.id)
      }
    } finally {
      this.flushing.delete(projectId)
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
    for (const connection of this.list()) {
      await this.check(connection.projectId).catch(() => undefined)
      await this.sendUsage(connection.projectId).catch(() => undefined)
    }
  }

  /**
   * 🔌 Manda à origem o uso das conversas deste projeto aqui, por dia (UTC), conversa, provedor e modelo. Reenvia desde
   * dois dias antes do último envio (o dia corrente cresce; a origem substitui a linha). Lá, entra na conta da conexão.
   */
  async sendUsage(projectId: string): Promise<number> {
    if (!this.deps.usage) return 0
    const connection = this.require(projectId)
    const from = connection.usageSentAt ? new Date(connection.usageSentAt.getTime() - 2 * 86_400_000) : connection.createdAt
    const since = new Date(`${from.toISOString().slice(0, 10)}T00:00:00Z`)
    const startedAt = this.now()
    const rows = (await this.deps.usage({ since, tzOffsetMinutes: 0, metadata: { [PROJECT_METADATA_KEY]: projectId } })).map((row) => ({
      day: row.day,
      conversationId: row.conversationId,
      agentId: row.agentId,
      provider: row.provider,
      model: row.model,
      turns: row.turns,
      usage: {
        inputTokens: row.usage.inputTokens ?? 0,
        outputTokens: row.usage.outputTokens ?? 0,
        reasoningTokens: row.usage.reasoningTokens ?? 0,
        totalTokens: row.usage.totalTokens ?? 0,
        cacheReadTokens: row.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: row.usage.cacheWriteTokens ?? 0,
      },
    }))
    for (let start = 0; start < rows.length; start += REMOTE_USAGE_MAX_ROWS) {
      const sent = await this.talk(projectId, (client) => client.usage(rows.slice(start, start + REMOTE_USAGE_MAX_ROWS)))
      if (!sent) return 0
    }
    this.deps.repository.update(projectId, { usageSentAt: startedAt })
    return rows.length
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

/** A recusa da origem na língua do ledger: os campos voltam como `InvalidLedgerError` (a ferramenta diz qual argumento). */
function remoteRefusal(error: RemoteRequestError): Error {
  if (error.status === 422 && Array.isArray(error.details)) return new InvalidLedgerError(error.details as Array<{ field: string; message: string }>)
  return new Error(error.message)
}
