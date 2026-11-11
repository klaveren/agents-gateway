import type { TCatalogFiles } from '../Catalog.Files'
import type { TCatalogKind } from '../Catalog.Document'
import type { IConnectionSecret } from '../models/ProjectConnection.Model'
import type { TRevisionOp } from './CatalogHistoryRepository.Port'
import type { ILedgerWrite } from '../models/Ledger.Model'

/** A origem respondeu que o token não vale (revogado, vencido, a conta saiu do projeto, outro projeto). */
export class RemoteUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteUnauthorizedError'
  }
}

/** A origem não respondeu ou respondeu erro que não é de credencial: rede, fora do ar, versão antiga do gateway. */
export class RemoteUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteUnavailableError'
  }
}

/** A origem recusou o pedido (não é credencial nem queda): o motivo dela, e os campos quando há. */
export class RemoteRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RemoteRequestError'
  }
}

/** Uma linha do "o que mudou", como chega pela rede. */
export interface IRemoteChange {
  kind: TCatalogKind
  id: string
  op: TRevisionOp
  revisions: number
  at: string
  by: string
}

export interface IRemoteChanges {
  version: number
  changes: IRemoteChange[]
  truncated?: boolean
}

/** O pacote da origem (`GET /connect/:p/package`). */
export interface IRemotePackage {
  version: number
  package: { manifest: unknown; files: TCatalogFiles }
  files: Array<{ sha256: string; bytes: number }>
  secrets: IConnectionSecret[]
  changes?: IRemoteChange[]
  truncated?: boolean
}

/** 🔌 A origem de um projeto conectado (as rotas `/connect/<projeto>/*` de outro gateway). */
export interface IRemoteCatalog {
  version(): Promise<number>
  changes(since: number): Promise<IRemoteChanges>
  package(since?: number): Promise<IRemotePackage>
  file(sha256: string): Promise<Buffer>
  /** O aviso ao vivo: chama `onVersion` a cada versão; resolve quando o stream fecha. */
  events(onVersion: (version: number) => void, signal: AbortSignal): Promise<void>
  /** 🔌 O ledger do agente, que mora na origem (as datas já como `Date`). */
  ledger(agentId: string): IRemoteLedger
}

/** O ledger de um agente na origem: as mesmas respostas do `LedgerService` de lá. */
export interface IRemoteLedger {
  index(): Promise<{ index: unknown; prompt: string | null }>
  context(topic: string): Promise<unknown>
  search(query: string): Promise<unknown>
  write(change: ILedgerWrite, conversationId?: string): Promise<unknown>
}
