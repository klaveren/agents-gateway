import { IAgent } from '@domain/models/Agent.Model'
import { IMcpServerConfig, mcpAsksProject, mcpEnvNames, mcpFixedVars, mcpProjectVarNames, mcpSelection, mcpServerKey } from '@domain/models/McpServer.Model'
import { IProject, IProjectMcpVar } from '@domain/models/Project.Model'
import { IResourceSecretView, MCP_SECRET_SCOPE, PROJECT_SECRET_SCOPE } from '@domain/models/ResourceSecret.Model'
import { ResourceSecretsService } from './ResourceSecrets.Service'

/**
 * ⚖️ PARA ONDE VAI o segredo que o MCP guardava (a migração da partida): o do MCP de projeto, para o projeto dele; o do
 * global, para os projetos que têm agente usando (o dono e os com quem ele é compartilhado). Global usado por agente
 * global — ou por ninguém — vai para todos: é o alcance que ele já tinha, e nenhum valor se perde.
 */
export function mcpEnvMigrationTargets(
  server: Pick<IMcpServerConfig, 'id' | 'projectId'>,
  agents: ReadonlyArray<Pick<IAgent, 'allowedTools' | 'projectId' | 'sharedWith'>>,
  projects: readonly string[],
): string[] {
  if (server.projectId) return projects.includes(server.projectId) ? [server.projectId] : []
  const users = agents.filter((agent) => mcpSelection(agent.allowedTools).has(server.id))
  if (!users.length || users.some((agent) => !agent.projectId)) return [...projects]
  return [...new Set(users.flatMap((agent) => [agent.projectId!, ...(agent.sharedWith ?? [])]))].filter((projectId) => projects.includes(projectId)).sort()
}

/** O que deu errado, com o status da resposta: o MCP ou a conta que não existe (404), o nome que já existe (409), o pedido (422). */
export class ProjectVariableError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectVariableError'
  }
}

/** Uma variável que um MCP pede ao projeto, como a tela a lê. ⛔ A secreta nunca traz o valor. */
export interface IMcpVariableView {
  name: string
  secret: boolean
  configured: boolean
  /** Só a visível. */
  value?: string
}

/** Um MCP que este projeto enxerga e que pede valor a ele. */
export interface IMcpVariablesView {
  key: string
  id: string
  name: string
  enabled: boolean
  /** Os nomes das fixas do MCP (o valor é do MCP, igual em todo projeto). */
  fixed: string[]
  variables: IMcpVariableView[]
}

export interface IProjectVariablesDeps {
  projects: { get(id: string): IProject; update(id: string, change: { mcpEnv: readonly IProjectMcpVar[] }, by: string): IProject }
  secrets: Pick<ResourceSecretsService, 'list' | 'save' | 'remove'>
  /** Os MCPs que este projeto enxerga: os globais e os dele. */
  mcps: (projectId: string) => readonly IMcpServerConfig[]
  /** A conta "variável secreta" do projeto, com o valor (para mover), e a remoção dela. Ausente: não há o que mover. */
  accounts?: {
    secretEnv(projectId: string, id: string): { name: string; value: string } | undefined
    remove(projectId: string, id: string): boolean
  }
}

/**
 * ⚖️ AS VARIÁVEIS DO PROJETO (Projeto → Ambiente → Variáveis): as SECRETAS (para todo agente do projeto, por baixo das do
 * agente), e os valores que o projeto dá às variáveis que cada MCP pede — esses vão só para o processo do MCP. As FIXAS
 * moram no próprio projeto (`IProject.env`) e mudam pela rota do projeto.
 *
 * ⛔ O valor secreto só entra: a leitura traz o nome e "configurado".
 */
export class ProjectVariablesService {
  constructor(private readonly deps: IProjectVariablesDeps) {}

  secrets(projectId: string): IResourceSecretView[] {
    this.deps.projects.get(projectId)
    return this.deps.secrets.list(PROJECT_SECRET_SCOPE, projectId)
  }

  saveSecret(projectId: string, input: { name: string; description?: string; value?: string }, by: string): IResourceSecretView {
    this.deps.projects.get(projectId)
    return this.deps.secrets.save(PROJECT_SECRET_SCOPE, projectId, input, by)
  }

  removeSecret(projectId: string, name: string): boolean {
    this.deps.projects.get(projectId)
    return this.deps.secrets.remove(PROJECT_SECRET_SCOPE, projectId, name)
  }

  /** Os MCPs que pedem valor a este projeto, cada um com o que pede e o que o projeto já deu. */
  mcpVariables(projectId: string): IMcpVariablesView[] {
    const project = this.deps.projects.get(projectId)
    return this.deps
      .mcps(projectId)
      .filter(mcpAsksProject)
      .map((server) => {
        const key = mcpServerKey(server)
        const secret = new Set(this.deps.secrets.list(MCP_SECRET_SCOPE, key, projectId).map((item) => item.name))
        const visible = (name: string) => project.mcpEnv?.find((item) => item.server === server.id && item.name === name)
        return {
          key,
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          fixed: Object.keys(mcpFixedVars(server)),
          variables: [
            ...mcpProjectVarNames(server).map((name) => {
              const found = visible(name)
              return { name, secret: false, configured: !!found, ...(found ? { value: found.value } : {}) }
            }),
            ...mcpEnvNames(server).map((name) => ({ name, secret: true, configured: secret.has(name) })),
          ],
        }
      })
  }

  /** O tipo da variável que o MCP pede: a visível, a secreta ou nenhuma (o MCP não pede esse nome). */
  kindOf(projectId: string, serverId: string, name: string): { server: IMcpServerConfig; secret: boolean } {
    const server = this.deps.mcps(projectId).find((item) => item.id === serverId)
    if (!server) throw new ProjectVariableError(404, `MCP server not found in this project: ${serverId}`)
    if (mcpProjectVarNames(server).includes(name)) return { server, secret: false }
    if (mcpEnvNames(server).includes(name)) return { server, secret: true }
    throw new ProjectVariableError(422, `${serverId} does not ask the project for ${name}; declare it on the MCP screen first`)
  }

  /** Grava o valor que o projeto dá a uma variável do MCP: a visível no projeto, a secreta no cofre. */
  saveMcpVariable(projectId: string, serverId: string, name: string, value: string, by: string): IMcpVariablesView {
    const { server, secret } = this.kindOf(projectId, serverId, name)
    if (secret) this.deps.secrets.save(MCP_SECRET_SCOPE, mcpServerKey(server), { name, value }, by, projectId)
    else {
      if (!value.trim()) throw new ProjectVariableError(422, 'value: required (empty does not clear: delete the value)')
      const current = this.deps.projects.get(projectId).mcpEnv ?? []
      this.deps.projects.update(projectId, { mcpEnv: [...current.filter((item) => !(item.server === serverId && item.name === name)), { server: serverId, name, value }] }, by)
    }
    return this.mcpVariables(projectId).find((item) => item.id === serverId)!
  }

  removeMcpVariable(projectId: string, serverId: string, name: string, by: string): boolean {
    const { server, secret } = this.kindOf(projectId, serverId, name)
    if (secret) return this.deps.secrets.remove(MCP_SECRET_SCOPE, mcpServerKey(server), name, projectId)
    const current = this.deps.projects.get(projectId).mcpEnv ?? []
    const next = current.filter((item) => !(item.server === serverId && item.name === name))
    if (next.length === current.length) return false
    this.deps.projects.update(projectId, { mcpEnv: next }, by)
    return true
  }

  /**
   * ⚖️ A CONTA "VARIÁVEL SECRETA" VIRA SECRETA DO PROJETO: o valor vai para as secretas, e a conta sai. Daí em diante vale
   * para TODO agente do projeto (a conta valia só para quem tinha a regra `account <id>`).
   * ⛔ Nome que o projeto já tem: recusa (409), para não trocar um valor por outro sem ninguém ver.
   */
  moveAccount(projectId: string, accountId: string, by: string): IResourceSecretView {
    this.deps.projects.get(projectId)
    const account = this.deps.accounts?.secretEnv(projectId, accountId)
    if (!account) throw new ProjectVariableError(404, `not a secret-variable account of this project (or its value no longer opens): ${accountId}`)
    if (this.deps.secrets.list(PROJECT_SECRET_SCOPE, projectId).some((item) => item.name === account.name))
      throw new ProjectVariableError(409, `the project already has the secret ${account.name}: remove one of them first`)
    const saved = this.deps.secrets.save(PROJECT_SECRET_SCOPE, projectId, { name: account.name, value: account.value, description: `veio da conta ${accountId}` }, by)
    this.deps.accounts!.remove(projectId, accountId)
    return saved
  }
}
