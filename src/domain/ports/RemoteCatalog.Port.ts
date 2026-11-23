import type { TCatalogFiles } from '../Catalog.Files'
import type { TCatalogKind } from '../Catalog.Document'
import type { IConnectionSecret } from '../models/ProjectConnection.Model'
import type { TRevisionOp } from './CatalogHistoryRepository.Port'
import type { ILedgerWrite } from '../models/Ledger.Model'
import type { TRemoteUsageInput } from '../models/RemoteUsage.Model'
import type { IPersonMessage, IPersonThread, TPersonMessageLevel, TPersonMessageStatus } from '../models/PersonMessage.Model'

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

/** 💬 O que a origem avisa de uma mensagem NOVA de agente para a conta da conexão (`message.new`). */
export interface IRemoteMessageNew {
  id: string
  key: string
  title?: string
  body: string
  level: TPersonMessageLevel
  agentId: string
  conversationId: string
}

/** O aviso ao vivo da origem: cada tipo de evento tem o seu ouvinte. */
export interface IRemoteEventHandlers {
  /** `catalog.version`: a versão do catálogo. */
  onVersion?: (version: number) => void
  /** 💬 `messages.changed`: a caixa da conta mudou (`unread` = as não lidas deste projeto). */
  onMessagesChanged?: (event: { unread: number }) => void
  /** 💬 `message.new`: uma mensagem nova de agente para a conta. */
  onMessageNew?: (event: IRemoteMessageNew) => void
}

/** 💬 A caixa de Mensagens da conta da conexão na origem (só o que é do projeto conectado). */
export interface IRemoteMessages {
  messages(archived?: boolean): Promise<{ threads: IPersonThread[]; unread: number; pending: number }>
  message(key: string): Promise<{ messages: IPersonMessage[] }>
  readMessage(key: string): Promise<{ unread: number }>
  archiveMessage(key: string, archived: boolean): Promise<{ unread: number }>
  setMessageStatus(key: string, messageId: string, status: Exclude<TPersonMessageStatus, 'answered'>): Promise<{ status: string; pending: number }>
  replyMessage(key: string, message: string, replyTo?: string): Promise<{ queued: boolean }>
}

/** 🔌 A origem de um projeto conectado (as rotas `/connect/<projeto>/*` de outro gateway). */
export interface IRemoteCatalog extends IRemoteMessages {
  version(): Promise<number>
  changes(since: number): Promise<IRemoteChanges>
  package(since?: number): Promise<IRemotePackage>
  file(sha256: string): Promise<Buffer>
  /** O aviso ao vivo; resolve quando o stream fecha. Uma função só = o ouvinte de versão (`onVersion`). */
  events(handlers: ((version: number) => void) | IRemoteEventHandlers, signal: AbortSignal): Promise<void>
  /** 🔌 O ledger do agente, que mora na origem (as datas já como `Date`). */
  ledger(agentId: string): IRemoteLedger
  /** 🔌 Manda o uso deste projeto aqui para a origem (reenviar o mesmo dia substitui lá). */
  usage(rows: readonly TRemoteUsageInput[]): Promise<{ received: number }>
}

/** O ledger de um agente na origem: as mesmas respostas do `LedgerService` de lá. */
export interface IRemoteLedger {
  index(): Promise<{ index: unknown; prompt: string | null }>
  context(topic: string): Promise<unknown>
  search(query: string): Promise<unknown>
  write(change: ILedgerWrite, conversationId?: string): Promise<unknown>
}
