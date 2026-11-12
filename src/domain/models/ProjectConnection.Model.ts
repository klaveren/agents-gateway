import type { TCatalogKind } from '../Catalog.Document'
import type { TRevisionOp } from '../ports/CatalogHistoryRepository.Port'

/**
 * 🔌 UM PROJETO CONECTADO: o projeto local `projectId` é a cópia SÓ DE LEITURA do projeto `remoteProjectId` do gateway
 * `url` (a .4). O catálogo vem de lá, versionado; mudar o catálogo é na origem, nunca aqui.
 *
 * - `ok`: a última conversa com a origem deu certo;
 * - `offline`: a origem não respondeu (rede, fora do ar) — o vigia tenta de novo;
 * - `unauthorized`: o token foi revogado, venceu ou a conta saiu do projeto — só um token novo resolve.
 */
export type TConnectionState = 'ok' | 'offline' | 'unauthorized'

/** Uma linha do aviso: o item, a última operação e quantas revisões teve desde a versão local. */
export interface IConnectionChange {
  kind: TCatalogKind
  id: string
  op: TRevisionOp
  revisions: number
  at: string
  by: string
}

/** O item que a última sincronização não gravou, e por quê (o resto entrou). */
export interface IConnectionSkipped {
  ref: string
  message: string
}

/** Uma variável que o projeto pede (o nome; o valor cada instalação preenche). */
export interface IConnectionSecret {
  kind: 'agent' | 'skill' | 'command'
  id: string
  name: string
  description?: string
}

export interface IProjectConnection {
  projectId: string
  url: string
  remoteProjectId: string
  /** A versão do catálogo que está aqui (0 = nunca sincronizou). */
  syncedVersion: number
  /** A última versão que a origem disse ter. `latestVersion > syncedVersion` = há atualização. */
  latestVersion: number
  state: TConnectionState
  lastError?: string
  /** O que mudou entre `syncedVersion` e `latestVersion` (o aviso, sempre até a última). */
  changes: IConnectionChange[]
  changesTruncated?: boolean
  skipped: IConnectionSkipped[]
  secrets: IConnectionSecret[]
  /** `provider/modelo` da origem → `provider/modelo` daqui (ver `Connect.Policy`). */
  modelMap: Record<string, string>
  createdAt: Date
  createdBy: string
  lastCheckedAt?: Date
  lastSyncedAt?: Date
  /** Até quando o uso daqui já foi mandado à origem (reenvia os últimos dias: o de hoje ainda cresce). */
  usageSentAt?: Date
}

/** Um aviso por projeto, sempre para a ÚLTIMA versão (nunca um por versão). */
export const hasUpdate = (connection: Pick<IProjectConnection, 'syncedVersion' | 'latestVersion'>) => connection.latestVersion > connection.syncedVersion
