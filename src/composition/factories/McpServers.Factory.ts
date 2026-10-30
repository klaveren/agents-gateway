import { McpServersService } from '@application/McpServers.Service'
import { mcpServerKey } from '@domain/models/McpServer.Model'
import { removeInstall } from '@infra/mcp/Mcp.Install'
import { makeAgents } from './Agents.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeCredentials } from './Credentials.Factory'
import { makeProjects } from './Projects.Factory'
import { makeTools } from './Tools.Factory'

let instance: McpServersService | undefined

/** O cadastro dos servidores MCP: um só, para a guia MCPs e para a remoção de projeto. */
export function makeMcpServers(): McpServersService {
  if (instance) return instance
  instance = new McpServersService(
    makeTools().servers,
    makeCredentials(),
    () =>
      makeAgents()
        .rawEntries()
        .map((entry) => entry.agent),
    (projectId) => makeProjects().exists(projectId),
  )
  instance.history.use(() => makeCatalogHistory())
  return instance
}

/** O projeto saiu: os MCPs dele também — cadastro, credenciais, cliente, instâncias e pacote. */
export function removeProjectMcpServers(projectId: string): void {
  const { mcp } = makeTools()
  for (const server of makeMcpServers().removeProject(projectId)) {
    const key = mcpServerKey(server)
    mcp.forget(key)
    void mcp.closeInstances({ serverId: key })
    if (server.kind === 'process') removeInstall(key)
  }
}
