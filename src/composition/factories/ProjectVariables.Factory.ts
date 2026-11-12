import { mcpEnvMigrationTargets, ProjectVariablesService } from '@application/ProjectVariables.Service'
import { IMcpServerConfig, mcpAsksProject, mcpEnvNames, mcpEnvSecretKey, mcpProjectVarNames, mcpServerKey } from '@domain/models/McpServer.Model'
import { MCP_SECRET_SCOPE } from '@domain/models/ResourceSecret.Model'
import { ProjectVariablesController } from '@infra/http/ProjectVariables.Controller'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeCredentials } from './Credentials.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { connectedLocalEnv, makeProjects } from './Projects.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'
import { makeTools } from './Tools.Factory'

let instance: ProjectVariablesService | undefined

/** As variáveis do projeto: as secretas e os valores que os MCPs pedem (ver `ProjectVariables.Service`). */
export function makeProjectVariables(): ProjectVariablesService {
  if (instance) return instance
  instance = new ProjectVariablesService({
    projects: makeProjects(),
    secrets: makeResourceSecrets(),
    mcps: (projectId) => makeTools().mcp.visibleTo(projectId),
    accounts: makeProjectAccounts(),
  })
  return instance
}

export function makeProjectVariablesController(): ProjectVariablesController {
  return new ProjectVariablesController({ variables: makeProjectVariables(), proof: makeAuth().proof })
}

/** As fixas do projeto (`IProject.env`); projeto que não existe, nenhuma. */
export function projectFixedEnv(projectId: string | undefined): Readonly<Record<string, string>> | undefined {
  if (!projectId || !makeProjects().exists(projectId)) return undefined
  // 🔌 Projeto conectado: as desta máquina por cima das que vêm da origem.
  const local = connectedLocalEnv(projectId)
  const env = makeProjects().get(projectId).env
  return local && Object.keys(local).length ? { ...env, ...local } : env
}

/**
 * ⛔ O que o PROJETO deu às variáveis do MCP, para o processo dele: as visíveis (do projeto) e as secretas (do cofre), só
 * os nomes que o MCP pede. Sem projeto, nada — o MCP sobe só com as fixas dele.
 */
export function projectMcpEnv(config: IMcpServerConfig, projectId: string | undefined, sessionId?: string): Record<string, string> {
  if (!projectId || !mcpAsksProject(config) || !makeProjects().exists(projectId)) return {}
  const asked = mcpProjectVarNames(config)
  const visible = (makeProjects().get(projectId).mcpEnv ?? []).filter((item) => item.server === config.id && asked.includes(item.name))
  const secretNames = mcpEnvNames(config)
  const secret = Object.entries(makeResourceSecrets().mcpEnv(mcpServerKey(config), projectId, sessionId)).filter(([name]) => secretNames.includes(name))
  return { ...Object.fromEntries(visible.map((item) => [item.name, item.value])), ...Object.fromEntries(secret) }
}

/**
 * ⚖️ A MIGRAÇÃO DA PARTIDA: o valor secreto que o MCP guardava (o cofre de credenciais, `mcp:<chave>:env:<NOME>`) vai para
 * os PROJETOS e sai do MCP. Vai para os projetos que têm agente usando o MCP; o MCP global usado por agente global (ou por
 * ninguém) vai para todos os projetos — o alcance de hoje, sem perder valor. Roda até o cofre esvaziar: idempotente.
 */
export function migrateMcpEnvToProjects(): void {
  const vault = makeCredentials()
  const secrets = makeResourceSecrets()
  const registry = makeTools().mcp
  const projects = makeProjects()
    .all()
    .map((project) => project.id)
  const agents = makeAgents()
    .entries()
    .map((entry) => entry.agent)
  for (const server of registry.list()) {
    const key = mcpServerKey(server)
    const stored = mcpEnvNames(server).flatMap((name) => {
      const value = vault.get(mcpEnvSecretKey(key, name))
      return value ? [{ name, value }] : []
    })
    if (!stored.length) continue
    const targets = mcpEnvMigrationTargets(server, agents, projects)
    for (const projectId of targets)
      for (const { name, value } of stored)
        if (!secrets.list(MCP_SECRET_SCOPE, key, projectId).some((item) => item.name === name && item.configured))
          secrets.save(MCP_SECRET_SCOPE, key, { name, value }, 'migração', projectId)
    for (const { name } of stored) vault.clear(mcpEnvSecretKey(key, name))
    console.log(`[variáveis] MCP ${key}: ${stored.map((item) => item.name).join(', ')} → ${targets.length ? targets.join(', ') : 'nenhum projeto'}`)
  }
}
