import { McpServersService } from '@application/McpServers.Service'
import { mcpServerKey } from '@domain/models/McpServer.Model'
import { removeInstall } from '@infra/mcp/Mcp.Install'
import { makeAgentLocalLayers } from './AgentLocalLayers.Factory'
import { makeAgents } from './Agents.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeCredentials } from './Credentials.Factory'
import { makeProjects } from './Projects.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'
import { MCP_SECRET_SCOPE } from '@domain/models/ResourceSecret.Model'
import { makeTools } from './Tools.Factory'

let instance: McpServersService | undefined

/** O cadastro dos servidores MCP: um só, para a guia MCPs e para a remoção de projeto. */
export function makeMcpServers(): McpServersService {
  if (instance) return instance
  instance = new McpServersService(
    makeTools().servers,
    makeCredentials(),
    // Com a camada local por cima (`entries`): o MCP que um agente conectado usa só por ela também está em uso.
    () =>
      makeAgents()
        .entries()
        .map((entry) => entry.agent),
    (projectId) => makeProjects().exists(projectId),
  )
  instance.history.use(() => makeCatalogHistory())
  instance.useLocalExtras((agent) => makeAgentLocalLayers().extras(agent))
  // Os valores que os projetos deram ao servidor (o cofre `mcp`) seguem a chave dele e somem com ele.
  instance.useProjectValues({
    move: (from, to, by) => makeResourceSecrets().moveScope(MCP_SECRET_SCOPE, from, to, by),
    forget: (key) => makeResourceSecrets().removeScope(MCP_SECRET_SCOPE, key),
  })
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
