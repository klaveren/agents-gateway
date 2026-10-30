import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { InvalidMcpServerError, McpServerInUseError } from '@domain/errors/Domain.Error'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { McpServersService } from './McpServers.Service'

const PROJECTS = ['cliente-a', 'cliente-b']

describe('McpServersService — MCP global ou de projeto', () => {
  const build = (agents: IAgent[] = []) => {
    const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')
    const repository = new SqliteMcpServerRepository(':memory:')
    return {
      service: new McpServersService(
        repository,
        secrets,
        () => agents,
        (id) => PROJECTS.includes(id),
      ),
      secrets,
      repository,
    }
  }
  const agent = (id: string, allowedTools: string[], projectId?: string): IAgent => ({
    id,
    name: id,
    ...(projectId ? { projectId } : {}),
    providers: [{ provider: EProvider.CLAUDE, models: ['m'] }],
    systemPrompt: 'p',
    modes: [EMode.CHAT],
    allowedTools,
  })
  const n8n = (projectId?: string, secret?: string) => ({
    id: 'n8n',
    name: 'n8n',
    url: 'https://n8n.x.com/mcp',
    auth: 'header' as const,
    ...(projectId ? { projectId } : {}),
    ...(secret ? { secret } : {}),
  })

  it('a chave: global é o id; de projeto, <projeto>.<id> — e volta', () => {
    assert.strictEqual(mcpServerKey({ id: 'n8n' }), 'n8n')
    assert.strictEqual(mcpServerKey({ id: 'n8n', projectId: 'cliente-a' }), 'cliente-a.n8n')
    assert.deepStrictEqual(parseMcpServerKey('cliente-a.n8n'), { id: 'n8n', projectId: 'cliente-a' })
    assert.deepStrictEqual(parseMcpServerKey('n8n'), { id: 'n8n' })
    for (const bad of ['a.b.c', '.n8n', 'x.', 'A.n8n', '../x']) assert.strictEqual(parseMcpServerKey(bad), undefined)
  })

  it('o mesmo id em dois projetos: dois servidores, cada um com o SEU segredo', () => {
    const { service, secrets } = build()
    service.create(n8n('cliente-a', 'chave-de-a'), 'root')
    service.create(n8n('cliente-b', 'chave-de-b'), 'root')

    assert.deepStrictEqual(
      service.list().map((server) => [server.id, server.projectId]),
      [
        ['n8n', 'cliente-a'],
        ['n8n', 'cliente-b'],
      ],
    )
    assert.strictEqual(secrets.get('mcp:cliente-a.n8n'), 'chave-de-a')
    assert.strictEqual(secrets.get('mcp:cliente-b.n8n'), 'chave-de-b')
    assert.strictEqual(secrets.get('mcp:n8n'), undefined)
    // O id solto acha só o global — que não existe.
    assert.throws(() => service.get('n8n'))
    assert.strictEqual(service.get('cliente-b.n8n').projectId, 'cliente-b')
  })

  it('⛔ id de projeto não colide com global, nos dois sentidos; e o projeto tem de existir', () => {
    const global = build()
    global.service.create(n8n(), 'root')
    assert.throws(
      () => global.service.create(n8n('cliente-a'), 'root'),
      (error: InvalidMcpServerError) => error.issues.some((issue) => issue.field === 'id' && /global/.test(issue.message)),
    )

    const scoped = build()
    scoped.service.create(n8n('cliente-a'), 'root')
    assert.throws(
      () => scoped.service.create(n8n(), 'root'),
      (error: InvalidMcpServerError) => error.issues.some((issue) => issue.field === 'id' && /cliente-a/.test(issue.message)),
    )
    assert.throws(() => scoped.service.create(n8n('cliente-a'), 'root'), InvalidMcpServerError)
    assert.throws(
      () => scoped.service.create(n8n('nao-existe'), 'root'),
      (error: InvalidMcpServerError) => error.issues.some((issue) => issue.field === 'projectId'),
    )
    // As sementes globais (o MCP do gateway, o do `.env`) não se tomam num projeto.
    assert.throws(() => scoped.service.create({ id: 'gateway', name: 'x', url: 'https://x.com/mcp', projectId: 'cliente-a' }, 'root'), InvalidMcpServerError)
  })

  it('⛔ a semente global não entra se um projeto já usa o id (seria ambíguo)', () => {
    const { repository } = build()
    const now = new Date()
    repository.insert({ id: 'crm', projectId: 'cliente-a', name: 'CRM', url: 'https://x.com/mcp', transport: 'auto', auth: 'none', enabled: true, createdAt: now, updatedAt: now })
    repository.seedOnce([{ id: 'crm', name: 'semente', url: 'https://y.com/mcp', transport: 'auto', auth: 'none', enabled: true, createdAt: now, updatedAt: now }])
    assert.deepStrictEqual(
      repository.list().map((server) => mcpServerKey(server)),
      ['cliente-a.crm'],
    )
  })

  it('uso: só conta o agente que ENXERGA o servidor', () => {
    const agents = [agent('de-a', ['mcp:n8n/*'], 'cliente-a'), agent('de-b', ['mcp:n8n/*'], 'cliente-b'), agent('global', ['mcp:n8n/x'])]
    const { service } = build(agents)
    service.create(n8n('cliente-a'), 'root')
    service.create(n8n('cliente-b'), 'root')
    assert.deepStrictEqual(
      service.usedBy('cliente-a.n8n').map((item) => item.id),
      ['de-a'],
    )
    assert.deepStrictEqual(
      service.usedBy('cliente-b.n8n').map((item) => item.id),
      ['de-b'],
    )
  })

  it('⛔ mudar de projeto que deixaria referência cruzada é recusado (409), dizendo quem usa', () => {
    const agents = [agent('de-a', ['mcp:n8n/*'], 'cliente-a'), agent('global', ['mcp:pw/*'])]
    const { service } = build(agents)
    service.create(n8n('cliente-a'), 'root')
    service.create({ id: 'pw', name: 'Playwright', url: 'https://pw.x.com/mcp' }, 'root')

    // Projeto → outro projeto: o agente de A perderia o servidor.
    assert.throws(
      () => service.update('cliente-a.n8n', { projectId: 'cliente-b' }, 'root'),
      (error: McpServerInUseError) => error instanceof McpServerInUseError && error.agents.some((name) => name.includes('de-a')),
    )
    // Global → projeto: o agente global passaria a citar um MCP de projeto.
    assert.throws(
      () => service.update('pw', { projectId: 'cliente-a' }, 'root'),
      (error: McpServerInUseError) => error instanceof McpServerInUseError && error.agents.some((name) => name.includes('global')),
    )
    assert.strictEqual(service.get('pw').projectId, undefined)
    assert.strictEqual(service.get('cliente-a.n8n').projectId, 'cliente-a')
  })

  it('mudar de projeto sem quebrar ninguém: a chave muda e o segredo e as variáveis vão junto', () => {
    const { service, secrets } = build([agent('de-a', ['mcp:n8n/*'], 'cliente-a')])
    service.create({ ...n8n('cliente-a', 'chave-de-a') }, 'root')
    service.create({ id: 'pw', name: 'Playwright', kind: 'container', container: { image: 'mcr.microsoft.com/playwright/mcp:latest', env: ['TOKEN'] } }, 'root')
    service.saveEnv('pw', 'TOKEN', 'tk', 'root')

    // Projeto → global: quem usava (do projeto) continua enxergando.
    const promoted = service.update('cliente-a.n8n', { projectId: null }, 'root')
    assert.deepStrictEqual([promoted.id, promoted.projectId], ['n8n', undefined])
    assert.deepStrictEqual([secrets.get('mcp:n8n'), secrets.get('mcp:cliente-a.n8n')], ['chave-de-a', undefined])

    const moved = service.update('pw', { projectId: 'cliente-b' }, 'root')
    assert.strictEqual(mcpServerKey(moved), 'cliente-b.pw')
    assert.deepStrictEqual([secrets.get('mcp:cliente-b.pw:env:TOKEN'), secrets.get('mcp:pw:env:TOKEN')], ['tk', undefined])
    assert.throws(() => service.get('pw'))

    // ⛔ E a troca de escopo também respeita a colisão.
    service.create({ id: 'crm', name: 'CRM', url: 'https://crm.x.com/mcp', projectId: 'cliente-a' }, 'root')
    service.create({ id: 'crm', name: 'CRM', url: 'https://crm.x.com/mcp', projectId: 'cliente-b' }, 'root')
    for (const target of ['cliente-b', null])
      assert.throws(
        () => service.update('cliente-a.crm', { projectId: target }, 'root'),
        (error: InvalidMcpServerError) => error.issues.some((issue) => issue.field === 'projectId'),
      )
  })

  it('o projeto apagado leva os MCPs dele, com as credenciais', () => {
    const { service, secrets } = build()
    service.create(n8n('cliente-a', 'chave-de-a'), 'root')
    service.create(n8n('cliente-b', 'chave-de-b'), 'root')
    assert.deepStrictEqual(
      service.removeProject('cliente-a').map((server) => mcpServerKey(server)),
      ['cliente-a.n8n'],
    )
    assert.deepStrictEqual(
      service.list().map((server) => mcpServerKey(server)),
      ['cliente-b.n8n'],
    )
    assert.deepStrictEqual([secrets.get('mcp:cliente-a.n8n'), secrets.get('mcp:cliente-b.n8n')], [undefined, 'chave-de-b'])
  })
})

describe('SqliteMcpServerRepository — escopo', () => {
  it('ida e volta: o projeto e o id voltam como foram', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-mcp-scope-'))
    try {
      const path = join(dir, 'db.sqlite')
      const now = new Date()
      const base = { name: 'n8n', url: 'https://n8n.x.com/mcp', transport: 'auto' as const, auth: 'none' as const, enabled: true, createdAt: now, updatedAt: now }
      const first = new SqliteMcpServerRepository(path)
      first.insert({ ...base, id: 'n8n', projectId: 'cliente-a' })
      first.insert({ ...base, id: 'pw' })

      const reopened = new SqliteMcpServerRepository(path)
      assert.deepStrictEqual(
        reopened.list().map((server) => [server.id, server.projectId]),
        [
          ['n8n', 'cliente-a'],
          ['pw', undefined],
        ],
      )
      assert.strictEqual(reopened.get('n8n'), undefined)
      assert.strictEqual(reopened.get('cliente-a.n8n')?.projectId, 'cliente-a')
      assert.strictEqual(reopened.move('cliente-a.n8n', 'cliente-b', now, 'root')?.projectId, 'cliente-b')
      assert.strictEqual(reopened.get('cliente-a.n8n'), undefined)
      assert.strictEqual(reopened.move('cliente-b.n8n', undefined, now, 'root')?.projectId, undefined)
      assert.strictEqual(reopened.get('n8n')?.id, 'n8n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('banco antigo, sem a coluna: ganha a coluna e tudo continua global', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-mcp-legacy-'))
    try {
      const path = join(dir, 'db.sqlite')
      const legacy = new DatabaseSync(path)
      legacy.exec(`CREATE TABLE mcp_servers (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'auto',
        auth TEXT NOT NULL DEFAULT 'caller', header_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`)
      legacy
        .prepare('INSERT INTO mcp_servers (id, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('crm', 'CRM', 'https://crm.x.com/mcp', new Date().toISOString(), new Date().toISOString())
      legacy.close()

      const repository = new SqliteMcpServerRepository(path)
      const server = repository.get('crm')
      assert.deepStrictEqual([server?.id, server?.projectId, server?.kind], ['crm', undefined, 'remote'])
      assert.ok(!('projectId' in (server ?? {})))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
