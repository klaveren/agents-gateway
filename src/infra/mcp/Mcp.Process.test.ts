import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { IMcpProcess, IMcpServerConfig } from '@domain/models/McpServer.Model'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { installDir, installPackage, installStatus, resolveCommand } from './Mcp.Install'
import { McpRegistry } from './Mcp.Registry'

/** Um MCP de verdade, pelo stdio: `whoami` devolve o pid, o cwd e a variável `FIXTURE_TOKEN`. */
const SERVER_SOURCE = `
const { Server } = require(${JSON.stringify(resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js'))})
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', inputSchema: { type: 'object', properties: {} } }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, cwd: process.cwd(), token: process.env.FIXTURE_TOKEN ?? null, key: process.env.OPENAI_API_KEY ?? null }) }],
}))
server.connect(new StdioServerTransport())
`

describe('MCP processo local', () => {
  let root: string
  let script: string
  const previousDb = process.env.CONVERSATIONS_DB

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-mcp-test-'))
    // A pasta de dados (e a de instalação) vem do banco: aqui, a temporária.
    process.env.CONVERSATIONS_DB = join(root, 'gateway.db')
    script = join(root, 'fixture-server.cjs')
    writeFileSync(script, SERVER_SOURCE)
  })
  after(() => {
    process.env.CONVERSATIONS_DB = previousDb
    rmSync(root, { recursive: true, force: true })
  })

  const registryWith = (proc: Partial<IMcpProcess>) => {
    const servers = new SqliteMcpServerRepository(':memory:')
    const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')
    const config: IMcpServerConfig = {
      id: 'fx',
      name: 'Fixture',
      kind: 'process',
      process: { command: process.execPath, args: [script], env: ['FIXTURE_TOKEN'], scope: 'conversation', ...proc },
      url: '',
      transport: 'auto',
      auth: 'none',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    servers.insert(config)
    secrets.save('mcp:fx:env:FIXTURE_TOKEN', 'tok-42', 'root')
    return new McpRegistry(servers, secrets)
  }
  const whoami = async (registry: McpRegistry, sessionId: string) => {
    const client = await registry.clientFor('fx', sessionId)
    assert.ok(client, 'sem cliente')
    const result = (await client.callToolRaw('whoami', {})) as { content: Array<{ text: string }> }
    return JSON.parse(result.content[0].text) as { pid: number; cwd: string; token: string | null; key: string | null }
  }

  it('⛔ uma instância por conversa: processos e pastas separados; a variável do cofre chega, o `.env` do gateway não', async () => {
    const previousKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-nao-pode-vazar'
    const registry = registryWith({})
    try {
      const a = await whoami(registry, 's-a')
      const b = await whoami(registry, 's-b')
      assert.notStrictEqual(a.pid, b.pid)
      assert.notStrictEqual(a.cwd, b.cwd)
      assert.deepStrictEqual([a.token, a.key], ['tok-42', null])
      assert.strictEqual((await whoami(registry, 's-a')).pid, a.pid)
      assert.strictEqual(registry.status()[0].instances, 2)

      assert.strictEqual(await registry.closeInstances({ serverId: 'fx' }), 2)
      assert.strictEqual(existsSync(a.cwd), false)
    } finally {
      process.env.OPENAI_API_KEY = previousKey
      await registry.closeInstances()
    }
  })

  it('HOME só leitura (o do pod): o processo ganha a pasta de trabalho como HOME', async () => {
    const readOnly = join(root, 'home-ro')
    mkdirSync(readOnly, { mode: 0o500 })
    const previousHome = process.env.HOME
    process.env.HOME = readOnly
    // O fixture devolve o HOME no lugar do token.
    writeFileSync(join(root, 'home.cjs'), SERVER_SOURCE.replace('process.env.FIXTURE_TOKEN', 'process.env.HOME'))
    const registry = registryWith({ args: [join(root, 'home.cjs')] })
    try {
      const seen = await whoami(registry, 's-h')
      assert.strictEqual(realpathSync(seen.token ?? ''), realpathSync(seen.cwd))
    } finally {
      process.env.HOME = previousHome
      await registry.closeInstances()
    }
  })

  it('`shared`: um processo só para todas as conversas, na pasta do servidor', async () => {
    const registry = registryWith({ scope: 'shared' })
    try {
      const a = await whoami(registry, 's-a')
      const b = await whoami(registry, 's-b')
      assert.strictEqual(a.pid, b.pid)
      assert.ok(a.cwd.endsWith(join('mcp', 'fx', 'work')), a.cwd)
      assert.strictEqual(registry.status()[0].instances, 1)
    } finally {
      await registry.closeInstances()
    }
  })

  it('"Testar conexão" abre uma instância descartável e lista as ferramentas', async () => {
    const registry = registryWith({})
    const result = await registry.test('fx')
    assert.deepStrictEqual([result.ok, result.tools.map((tool) => tool.name)], [true, ['whoami']])
    assert.strictEqual(registry.status()[0].instances, 0)
  })

  it('comando que não sobe vira erro legível, com o stderr', async () => {
    writeFileSync(join(root, 'quebrado.cjs'), "console.error('faltou o navegador'); process.exit(3)")
    const registry = registryWith({ args: [join(root, 'quebrado.cjs')] })
    const result = await registry.test('fx')
    assert.strictEqual(result.ok, false)
    assert.match(result.message ?? '', /faltou o navegador/)
  })

  describe('instalação', () => {
    const fakeInstall = (id: string, name: string, bin: string | Record<string, string>, spec = `${name}@1.0.0`) => {
      const dir = installDir(id)
      const pkg = join(dir, 'node_modules', name)
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin }))
      for (const entry of typeof bin === 'string' ? [name.replace(/^@[^/]+\//, '')] : Object.keys(bin)) symlinkSync(script, join(dir, 'node_modules', '.bin', entry))
      writeFileSync(join(dir, 'gateway-install.json'), JSON.stringify({ spec, name, version: '1.0.0', installedAt: new Date().toISOString() }))
    }

    it('o bin do pacote: único, o de nome igual ao do pacote, ou o escolhido no `command`', () => {
      fakeInstall('um', '@escopo/mcp-um', 'cli.js')
      assert.ok(resolveCommand('um', { package: '@escopo/mcp-um@1.0.0' }).endsWith(join('.bin', 'mcp-um')))

      fakeInstall('varios', 'mcp-varios', { outro: 'a.js', 'mcp-varios': 'b.js' })
      assert.ok(resolveCommand('varios', { package: 'mcp-varios' }).endsWith(join('.bin', 'mcp-varios')))
      assert.ok(resolveCommand('varios', { package: 'mcp-varios', command: 'outro' }).endsWith(join('.bin', 'outro')))
      assert.throws(() => resolveCommand('varios', { package: 'mcp-varios', command: 'nao-tem' }), /has no bin named nao-tem/)
    })

    it('sem instalar: erro que manda instalar; pacote trocado no cadastro: `stale`', () => {
      assert.throws(() => resolveCommand('nunca', { package: 'x' }), /not installed yet/)
      assert.deepStrictEqual(installStatus('nunca', 'x'), { installed: false })
      fakeInstall('trocado', 'mcp-trocado', 'cli.js')
      assert.strictEqual(installStatus('trocado', 'mcp-trocado@1.0.0').stale, undefined)
      assert.strictEqual(installStatus('trocado', 'mcp-trocado@2.0.0').stale, true)
    })

    it('`npm install` de um pacote local (sem rede): instala, registra a versão e acha o bin', async () => {
      const source = join(root, 'pacote-local')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'mcp-local-teste', version: '3.2.1', bin: { 'mcp-local-teste': 'server.cjs' } }))
      writeFileSync(join(source, 'server.cjs'), `#!/usr/bin/env node\n${SERVER_SOURCE}`, { mode: 0o755 })

      const result = await installPackage('local', source)
      assert.deepStrictEqual([result.ok, result.version], [true, '3.2.1'], result.log)
      assert.deepStrictEqual([installStatus('local', source).installed, installStatus('local', source).version], [true, '3.2.1'])
      assert.ok(resolveCommand('local', { package: source }).endsWith(join('.bin', 'mcp-local-teste')))

      const failed = await installPackage('local', join(root, 'nao-existe'))
      assert.strictEqual(failed.ok, false)
      assert.strictEqual(installStatus('local', source).version, '3.2.1', 'a instalação anterior fica de pé')
    })
  })
})
