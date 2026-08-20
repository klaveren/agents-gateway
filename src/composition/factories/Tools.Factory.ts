import { McpServerClient } from '@infra/mcp/McpServer.Client'
import { makeLocalTools } from '@infra/tools/Local.Tools'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'

export interface ITools {
  mcp: McpServerClient
  catalog: ToolCatalog
}

let instance: ITools | undefined

/**
 * Uma instância só, compartilhada. Antes havia dois `McpServerClient` divergentes: um
 * criado e conectado no `main.ts`, outro criado na composição e nunca conectado.
 */
export function makeTools(): ITools {
  if (!instance) {
    const mcp = new McpServerClient(process.env.MCP_SERVER_URL || 'http://localhost:8000/mcp')
    instance = { mcp, catalog: new ToolCatalog(mcp, makeLocalTools()) }
  }
  return instance
}
