import type { ICatalogPackage } from '@application/CatalogExport.Usecase'
import type { TCatalogScope } from '@application/Catalog.Reader'
import type { ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import type { ICatalogHistoryRepository, TRevisionOp } from '@domain/ports/CatalogHistoryRepository.Port'
import type { TSecretScope } from '@domain/models/ResourceSecret.Model'
import type { ILedgerWrite } from '@domain/models/Ledger.Model'
import { IRemoteUsageRow, REMOTE_USAGE_MAX_ROWS, remoteUsageKey, TRemoteUsageInput } from '@domain/models/RemoteUsage.Model'
import { LedgerNotFoundError } from '@domain/errors/Domain.Error'
import type { LedgerService } from './Ledger.Service'

/** Quantas revisões o "o que mudou" junta de uma vez (o aviso diz quando passou disso). */
export const CONNECT_CHANGES_LIMIT = 500

export interface IConnectDeps {
  history: Pick<ICatalogHistoryRepository, 'versionOf' | 'since'>
  exporter: { run(scope: TCatalogScope, by?: string): ICatalogPackage }
  reader: { list(scope: TCatalogScope): ICatalogDocument[] }
  /** O conteúdo de um arquivo de recurso, pelo sha256 (o blob store). */
  files: { read(sha256: string): Buffer | undefined }
  /** Os NOMES das variáveis de um recurso ou agente (nunca o valor). */
  secrets?: { list(scope: TSecretScope, scopeId: string): ReadonlyArray<{ name: string; description?: string }> }
  /** O ledger dos agentes (o MESMO serviço das ferramentas daqui). */
  ledger?: Pick<LedgerService, 'index' | 'context' | 'search' | 'write' | 'promptSection'>
  /** O projeto do agente (`null` = global; `undefined` = não existe). */
  agentProject?: (agentId: string) => string | null | undefined
  /** Onde fica o uso que os gateways conectados mandam. */
  usage?: { upsert(rows: readonly IRemoteUsageRow[], at: Date): void }
  now?: () => Date
}

/** Uma mudança no aviso: um item, a última operação e quantas revisões ele teve desde a versão local. */
export interface IConnectChange {
  kind: TCatalogKind
  id: string
  op: TRevisionOp
  revisions: number
  at: Date
  by: string
}

export interface IConnectPackage {
  /** A versão que este pacote é (lida ANTES do export: uma mudança no meio só gera outro aviso, nunca um pacote velho com versão nova). */
  version: number
  package: ICatalogPackage
  /** Os arquivos que os documentos citam; quem conecta baixa só os que não tem (`file`). */
  files: Array<{ sha256: string; bytes: number }>
  /** As variáveis que o projeto pede, por dono. Os valores nunca saem: cada instalação preenche os seus. */
  secrets: Array<{ kind: TSecretScope; id: string; name: string; description?: string }>
  /** Com `since`: o que mudou desde aquela versão, um item por linha. */
  changes?: IConnectChange[]
  /** As revisões passaram do teto: o aviso mostra a lista parcial. */
  truncated?: boolean
}

const SECRET_KINDS: ReadonlySet<string> = new Set<TSecretScope>(['agent', 'skill', 'command'])

/**
 * 🔌 A ORIGEM DE UM PROJETO CONECTADO: o gateway de um dev usa o projeto desta instalação (a .4) como fonte do catálogo.
 *
 * ⚖️ O catálogo vai INTEIRO e SÓ DE LEITURA (o export do projeto, já mascarado), com a versão e, se pedido, o que mudou
 * desde a versão de quem pergunta — um aviso só, sempre para a última. Os arquivos vão sob demanda, e só os que algum
 * documento do projeto cita: o token de conexão não lê blob de outro projeto.
 */
export class ConnectService {
  constructor(private readonly deps: IConnectDeps) {}

  version(projectId: string): { version: number } {
    return { version: this.deps.history.versionOf(projectId) }
  }

  package(projectId: string, by: string, since?: number): IConnectPackage {
    const scope: TCatalogScope = { kind: 'project', projectId }
    const version = this.deps.history.versionOf(projectId)
    const pack = this.deps.exporter.run(scope, by)
    const documents = this.deps.reader.list(scope)
    const files = [...filesOf(documents).values()]
    const secrets = documents
      .filter((document) => SECRET_KINDS.has(document.kind))
      .flatMap((document) =>
        (this.deps.secrets?.list(document.kind as TSecretScope, document.id) ?? []).map((secret) => ({
          kind: document.kind as TSecretScope,
          id: document.id,
          name: secret.name,
          ...(secret.description ? { description: secret.description } : {}),
        })),
      )
    const result: IConnectPackage = { version, package: pack, files, secrets }
    if (since === undefined) return result
    const revisions = this.deps.history.since(projectId, since, CONNECT_CHANGES_LIMIT)
    return { ...result, changes: collapse(revisions), ...(revisions.length >= CONNECT_CHANGES_LIMIT ? { truncated: true } : {}) }
  }

  /** O que mudou desde `since`, sem o pacote: é o que o aviso mostra antes de a pessoa atualizar. */
  changes(projectId: string, since: number): { version: number; changes: IConnectChange[]; truncated?: boolean } {
    const version = this.deps.history.versionOf(projectId)
    const revisions = this.deps.history.since(projectId, since, CONNECT_CHANGES_LIMIT)
    return { version, changes: collapse(revisions), ...(revisions.length >= CONNECT_CHANGES_LIMIT ? { truncated: true } : {}) }
  }

  /**
   * 🔌 O LEDGER DE UM AGENTE DO PROJETO, pela conexão: o ledger é UM só, o daqui — o gateway do dev lê e escreve nele
   * ao vivo. ⛔ Só agente do projeto da conexão; o resto responde como inexistente.
   */
  ledger(projectId: string, agentId: string) {
    const ledger = this.deps.ledger
    if (!ledger || this.deps.agentProject?.(agentId) !== projectId) throw new LedgerNotFoundError('agent', agentId)
    return {
      index: () => ({ index: ledger.index(agentId), prompt: ledger.promptSection(agentId) ?? null }),
      context: (topic: string) => ledger.context(agentId, topic),
      search: (query: string) => ledger.search(agentId, query),
      write: (change: ILedgerWrite, author: { via: string; conversationId?: string }) =>
        ledger.write(agentId, change, { kind: 'agent', agentId, via: author.via, ...(author.conversationId ? { conversationId: author.conversationId } : {}) }),
    }
  }

  /**
   * 🔌 O USO que o gateway conectado gastou NESTE projeto, por dia: entra no uso daqui, na conta dona da conexão (o custo,
   * quem administra vê como o de qualquer conversa). Reenviar o mesmo dia substitui. Devolve quantas linhas gravou.
   */
  receiveUsage(projectId: string, account: { userId: string; email: string }, rows: readonly TRemoteUsageInput[]): { received: number } {
    if (!this.deps.usage) throw new LedgerNotFoundError('agent', 'usage')
    const stored = rows.slice(0, REMOTE_USAGE_MAX_ROWS).map((row) => ({ ...row, key: remoteUsageKey(row), projectId, userId: account.userId, email: account.email }))
    this.deps.usage.upsert(stored, (this.deps.now ?? (() => new Date()))())
    return { received: stored.length }
  }

  /** ⛔ Só um arquivo que um documento do projeto cita; o resto responde como inexistente. */
  file(projectId: string, sha256: string): Buffer | undefined {
    if (!filesOf(this.deps.reader.list({ kind: 'project', projectId })).has(sha256)) return undefined
    return this.deps.files.read(sha256)
  }
}

/** Os arquivos citados (`files: [{ path, sha256, bytes }]` no corpo do skill, do comando e do agente). */
function filesOf(documents: readonly ICatalogDocument[]): Map<string, { sha256: string; bytes: number }> {
  const found = new Map<string, { sha256: string; bytes: number }>()
  for (const document of documents) {
    const list = (document.body as Record<string, unknown>).files
    if (!Array.isArray(list)) continue
    for (const file of list as Array<Record<string, unknown>>) if (typeof file.sha256 === 'string') found.set(file.sha256, { sha256: file.sha256, bytes: Number(file.bytes) || 0 })
  }
  return found
}

/** Uma linha por item, com a última operação: o aviso diz "skill X: 3 revisões", não as 3. */
function collapse(revisions: ReadonlyArray<{ kind: TCatalogKind; itemId: string; op: TRevisionOp; at: Date; by: string }>): IConnectChange[] {
  const items = new Map<string, IConnectChange>()
  for (const revision of revisions) {
    const key = `${revision.kind}:${revision.itemId}`
    const seen = items.get(key)
    items.set(key, { kind: revision.kind, id: revision.itemId, op: revision.op, revisions: (seen?.revisions ?? 0) + 1, at: revision.at, by: revision.by })
  }
  return [...items.values()]
}
