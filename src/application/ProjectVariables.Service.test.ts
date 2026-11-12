import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { IProject, IProjectMcpVar } from '@domain/models/Project.Model'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { mcpEnvMigrationTargets, ProjectVariableError, ProjectVariablesService } from './ProjectVariables.Service'
import { ResourceSecretsService } from './ResourceSecrets.Service'

describe('ProjectVariablesService', () => {
  const at = new Date('2026-11-12T12:00:00Z')
  const n8n: IMcpServerConfig = {
    id: 'n8n',
    name: 'n8n',
    kind: 'process',
    process: { command: 'npx', args: [], vars: { N8N_MODE: 'api' }, projectVars: ['N8N_URL'], env: ['N8N_API_KEY'], scope: 'shared' },
    url: '',
    transport: 'auto',
    auth: 'none',
    enabled: true,
    createdAt: at,
    updatedAt: at,
  }
  const plain: IMcpServerConfig = { ...n8n, id: 'sem-pedido', name: 'Sem pedido', process: { args: [], command: 'x', env: [], scope: 'conversation' } }

  function setup(accounts: Record<string, { name: string; value: string }> = {}, connected?: { list: IProjectMcpVar[] }) {
    const project: IProject = { id: 'alfa', name: 'Alfa', createdAt: at, updatedAt: at }
    const secrets = new ResourceSecretsService({
      store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
      exists: (scope, id) => (scope === 'project' && id === 'alfa') || (scope === 'mcp' && id === 'n8n'),
    })
    const removed: string[] = []
    const service = new ProjectVariablesService({
      projects: {
        get: (id) => {
          if (id !== 'alfa') throw new ProjectVariableError(404, `no project ${id}`)
          return project
        },
        update: (_id, change: { mcpEnv: readonly IProjectMcpVar[] }) => Object.assign(project, { mcpEnv: [...change.mcpEnv] }),
      },
      secrets,
      mcps: () => [n8n, plain],
      accounts: {
        secretEnv: (_projectId, id) => accounts[id],
        remove: (_projectId, id) => (removed.push(id), true),
      },
      ...(connected ? { connected: { read: () => [...connected.list], write: (_id: string, list: IProjectMcpVar[]) => void (connected.list = list) } } : {}),
    })
    return { service, secrets, project, removed }
  }

  it('🔌 projeto conectado: o valor visível é desta máquina, por cima do da origem; apagar tira só o daqui', () => {
    const connected = { list: [] as IProjectMcpVar[] }
    const { service, project } = setup({}, connected)
    project.mcpEnv = [{ server: 'n8n', name: 'N8N_URL', value: 'https://da-origem' }]
    const before = service.mcpVariables('alfa')[0]!.variables.find((item) => item.name === 'N8N_URL')
    assert.deepStrictEqual(before, { name: 'N8N_URL', secret: false, configured: true, value: 'https://da-origem' })

    service.saveMcpVariable('alfa', 'n8n', 'N8N_URL', 'http://localhost:5678', 'dev')
    assert.deepStrictEqual(connected.list, [{ server: 'n8n', name: 'N8N_URL', value: 'http://localhost:5678' }])
    assert.deepStrictEqual(project.mcpEnv, [{ server: 'n8n', name: 'N8N_URL', value: 'https://da-origem' }], 'o da origem não muda')
    assert.deepStrictEqual(
      service.mcpVariables('alfa')[0]!.variables.find((item) => item.name === 'N8N_URL'),
      { name: 'N8N_URL', secret: false, configured: true, value: 'http://localhost:5678', local: true },
    )

    assert.strictEqual(service.removeMcpVariable('alfa', 'n8n', 'N8N_URL', 'dev'), true)
    assert.deepStrictEqual(connected.list, [])
    assert.strictEqual(service.mcpVariables('alfa')[0]!.variables.find((item) => item.name === 'N8N_URL')?.value, 'https://da-origem')
    assert.strictEqual(service.removeMcpVariable('alfa', 'n8n', 'N8N_URL', 'dev'), false, 'o da origem não sai daqui')
  })

  it('lista só o MCP que pede valor ao projeto: as fixas pelo nome, a visível com o valor, a secreta sem', () => {
    const { service } = setup()
    service.saveMcpVariable('alfa', 'n8n', 'N8N_URL', 'https://n8n.alfa', 'ana')
    service.saveMcpVariable('alfa', 'n8n', 'N8N_API_KEY', 'chave-de-alfa', 'ana')
    assert.deepStrictEqual(service.mcpVariables('alfa'), [
      {
        key: 'n8n',
        id: 'n8n',
        name: 'n8n',
        enabled: true,
        fixed: ['N8N_MODE'],
        variables: [
          { name: 'N8N_URL', secret: false, configured: true, value: 'https://n8n.alfa' },
          { name: 'N8N_API_KEY', secret: true, configured: true },
        ],
      },
    ])
    assert.ok(!JSON.stringify(service.mcpVariables('alfa')).includes('chave-de-alfa'), 'a secreta não volta')
  })

  it('a visível mora no projeto, a secreta no cofre; recusa o nome que o MCP não pede e o MCP que o projeto não vê', () => {
    const { service, secrets, project } = setup()
    service.saveMcpVariable('alfa', 'n8n', 'N8N_URL', 'https://um', 'ana')
    service.saveMcpVariable('alfa', 'n8n', 'N8N_URL', 'https://dois', 'ana')
    assert.deepStrictEqual(project.mcpEnv, [{ server: 'n8n', name: 'N8N_URL', value: 'https://dois' }])
    service.saveMcpVariable('alfa', 'n8n', 'N8N_API_KEY', 'chave', 'ana')
    assert.deepStrictEqual(secrets.mcpEnv('n8n', 'alfa'), { N8N_API_KEY: 'chave' })

    assert.throws(
      () => service.saveMcpVariable('alfa', 'n8n', 'N8N_MODE', 'x', 'ana'),
      (error: ProjectVariableError) => error.status === 422,
    )
    assert.throws(
      () => service.saveMcpVariable('alfa', 'outro', 'X', 'x', 'ana'),
      (error: ProjectVariableError) => error.status === 404,
    )
    assert.throws(
      () => service.saveMcpVariable('alfa', 'n8n', 'N8N_URL', '  ', 'ana'),
      (error: ProjectVariableError) => error.status === 422,
    )

    assert.strictEqual(service.removeMcpVariable('alfa', 'n8n', 'N8N_URL', 'ana'), true)
    assert.strictEqual(service.removeMcpVariable('alfa', 'n8n', 'N8N_URL', 'ana'), false)
    assert.strictEqual(service.removeMcpVariable('alfa', 'n8n', 'N8N_API_KEY', 'ana'), true)
    assert.deepStrictEqual([project.mcpEnv, secrets.mcpEnv('n8n', 'alfa')], [[], {}])
  })

  it('⚖️ a conta "variável secreta" vira secreta do projeto e sai; nome que o projeto já tem é 409', () => {
    const { service, secrets, removed } = setup({ gitlab: { name: 'GITLAB_TOKEN', value: 'glpat-1' }, outra: { name: 'GITLAB_TOKEN', value: 'glpat-2' } })
    const moved = service.moveAccount('alfa', 'gitlab', 'ana')
    assert.deepStrictEqual([moved.name, moved.configured, removed], ['GITLAB_TOKEN', true, ['gitlab']])
    assert.deepStrictEqual(secrets.envFor(undefined, undefined, 'alfa').env, { GITLAB_TOKEN: 'glpat-1' })
    assert.throws(
      () => service.moveAccount('alfa', 'outra', 'ana'),
      (error: ProjectVariableError) => error.status === 409,
    )
    assert.throws(
      () => service.moveAccount('alfa', 'nao-existe', 'ana'),
      (error: ProjectVariableError) => error.status === 404,
    )
    assert.deepStrictEqual(removed, ['gitlab'])
  })

  it('⚖️ a migração: o MCP de projeto vai para o dele; o global, para quem usa — ou para todos, se agente global usa ou ninguém usa', () => {
    const projects = ['alfa', 'beta', 'gama']
    const agent = (projectId: string | undefined, tools: string[], sharedWith?: string[]) => ({ projectId, allowedTools: tools, ...(sharedWith ? { sharedWith } : {}) })
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n', projectId: 'beta' }, [], projects), ['beta'])
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n', projectId: 'sumiu' }, [], projects), [])
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n' }, [agent('gama', ['mcp:n8n/*']), agent('alfa', ['mcp:n8n/listar'], ['beta'])], projects), ['alfa', 'beta', 'gama'])
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n' }, [agent('gama', ['mcp:n8n/*']), agent('alfa', ['mcp:outro/*'])], projects), ['gama'])
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n' }, [agent(undefined, ['mcp:n8n/*'])], projects), projects)
    assert.deepStrictEqual(mcpEnvMigrationTargets({ id: 'n8n' }, [], projects), projects)
  })
})
