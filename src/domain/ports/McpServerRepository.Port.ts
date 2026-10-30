import { IMcpServerConfig } from '@domain/models/McpServer.Model'

export type TMcpServerPatch = Partial<
  Pick<IMcpServerConfig, 'name' | 'url' | 'container' | 'process' | 'transport' | 'auth' | 'headerName' | 'identity' | 'enabled' | 'updatedAt' | 'updatedBy'>
>

/**
 * Onde ficam os servidores MCP. Síncrono, como providers: é lido no caminho de cada turno. ⛔ Escrever lança.
 *
 * ⚖️ TUDO PELA CHAVE (`mcpServerKey`): global é o id, de projeto `<projeto>.<id>`. Um id solto só acha o global.
 */
export interface IMcpServerRepository {
  list(): IMcpServerConfig[]
  get(key: string): IMcpServerConfig | undefined
  insert(server: IMcpServerConfig): void
  update(key: string, patch: TMcpServerPatch): IMcpServerConfig | undefined
  /** Troca o escopo (global ↔ projeto): a chave muda junto. `undefined` = não existia. */
  move(key: string, projectId: string | undefined, at: Date, by: string): IMcpServerConfig | undefined
  delete(key: string): boolean
  /** Grava a semente UMA VEZ por banco (a marca impede que um servidor apagado volte no boot). */
  seedOnce(servers: readonly IMcpServerConfig[]): void
}
