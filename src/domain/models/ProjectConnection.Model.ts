import type { IProjectMcpVar } from './Project.Model'
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

/**
 * 🔄 A última atualização AUTOMÁTICA (`autoUpdate`): o aviso "atualizado vX → vY" até a pessoa vê-lo (`seen`). Duas
 * seguidas sem ninguém ver viram uma só (de onde a primeira partiu até a última).
 */
export interface IConnectionUpdate {
  from: number
  to: number
  changes: IConnectionChange[]
  changesTruncated?: boolean
  at: string
  seen: boolean
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
  /**
   * As variáveis FIXAS desta máquina (texto comum: o endereço de um serviço local), por cima das fixas que vêm da origem
   * (`IProject.env`, só leitura aqui). Nunca vão para a origem; ao desconectar, passam para o projeto. Ausente = nenhuma.
   */
  localEnv?: Record<string, string>
  /**
   * Os valores visíveis DESTA MÁQUINA para as variáveis "Do projeto" dos MCPs (`IProject.mcpEnv`), por cima dos que vêm da
   * origem: o MCP desta máquina (que a origem não conhece) e a URL local de um serviço. Ao desconectar, passam para o
   * projeto. Ausente = nenhum.
   */
  localMcpEnv?: IProjectMcpVar[]
  /** 🔄 Versão nova na origem entra sozinha (ligada por padrão); desligada, fica o aviso com o botão Atualizar. */
  autoUpdate: boolean
  lastUpdate?: IConnectionUpdate
  createdAt: Date
  createdBy: string
  lastCheckedAt?: Date
  lastSyncedAt?: Date
  /**
   * 🔌 Desde quando os modelos e os grupos do projeto são DESTA MÁQUINA (ver `ConnectedModels.Migration`). Ausente = a conexão
   * é de antes: a manutenção da subida ainda não limpou o que veio da origem.
   */
  modelsLocalAt?: Date
  /** Até quando o uso daqui já foi mandado à origem (reenvia os últimos dias: o de hoje ainda cresce). */
  usageSentAt?: Date
}

/** Um aviso por projeto, sempre para a ÚLTIMA versão (nunca um por versão). */
export const hasUpdate = (connection: Pick<IProjectConnection, 'syncedVersion' | 'latestVersion'>) => connection.latestVersion > connection.syncedVersion
