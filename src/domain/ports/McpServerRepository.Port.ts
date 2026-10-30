import { IMcpServerConfig } from '@domain/models/McpServer.Model'

export type TMcpServerPatch = Partial<
  Pick<IMcpServerConfig, 'name' | 'url' | 'container' | 'process' | 'transport' | 'auth' | 'headerName' | 'identity' | 'enabled' | 'updatedAt' | 'updatedBy'>
>

/** Onde ficam os servidores MCP. Síncrono, como providers: é lido no caminho de cada turno. ⛔ Escrever lança. */
export interface IMcpServerRepository {
  list(): IMcpServerConfig[]
  get(id: string): IMcpServerConfig | undefined
  insert(server: IMcpServerConfig): void
  update(id: string, patch: TMcpServerPatch): IMcpServerConfig | undefined
  delete(id: string): boolean
  /** Grava a semente UMA VEZ por banco (a marca impede que um servidor apagado volte no boot). */
  seedOnce(servers: readonly IMcpServerConfig[]): void
}
