import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MicromambaAdapter } from '@infra/packages/Micromamba.Adapter'
import { HttpServer } from './Http.Server'
import { randomBytes } from 'node:crypto'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { HooksController } from './Hooks.Controller'
import { GuidanceController } from './Guidance.Controller'
import { GuidanceService } from '@application/Guidance.Service'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { PackagesController } from './Packages.Controller'

/** Um micromamba falso: instala `jq` (cria o ambiente) e lista o que está lá. */
const FAKE_MAMBA = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const out = (value) => process.stdout.write(JSON.stringify(value))
const prefix = args[args.indexOf('-p') + 1]
if (args[0] === '--version') out('2.9.0')
else if (args[0] === 'create' || args[0] === 'install') { fs.mkdirSync(prefix + '/conda-meta', { recursive: true }); fs.writeFileSync(prefix + '/installed', args.at(-1)) }
else if (args[0] === 'list') out({ packages: fs.existsSync(prefix + '/installed') ? [{ name: fs.readFileSync(prefix + '/installed', 'utf8'), version: '1.8.2' }] : [] })
else if (args[0] === 'env') out({ dependencies: fs.existsSync(prefix + '/installed') ? [fs.readFileSync(prefix + '/installed', 'utf8')] : [] })
`

const PASSWORD = 'frase longa o bastante'

describe('MCP do próprio gateway (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let member = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return (await res.json()) as { result?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /** Um cliente MCP de verdade (o do SDK), com a conta no mesmo header da API. */
  const connect = async (token: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Tool-Authorization': `Bearer ${token}` } } }))
    return client
  }
  let mambaDir: string
  const names = async (token: string) => (await (await connect(token)).listTools()).tools.map((tool) => tool.name).sort()
  const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    delete process.env.SELF_MCP_WRITE
    const controller = makeController()
    mambaDir = mkdtempSync(join(tmpdir(), 'gw-selfmcp-mamba-'))
    writeFileSync(join(mambaDir, 'micromamba'), FAKE_MAMBA)
    chmodSync(join(mambaDir, 'micromamba'), 0o755)
    const packages = new PackagesController({
      packages: new MicromambaAdapter(join(mambaDir, 'micromamba'), join(mambaDir, 'tools'), join(mambaDir, 'root')),
      proof: makeAuth().proof,
    })
    const hooks = new HooksController({
      hooks: new AgentHooksService(new SqliteAgentHookRepository(), new SqliteCredentialStore(new SecretBox(randomBytes(32))), (id) => !!makeAgents().get(id)),
      proof: makeAuth().proof,
      sessionFor: () => undefined,
    })
    const server = new HttpServer(
      controller,
      makeAuthController(),
      makeProvidersController(),
      makeUsageController(controller.conversations),
      undefined,
      undefined,
      packages,
      hooks,
      undefined,
      new GuidanceController({ guidance: new GuidanceService(new SqliteGuidanceRepository(), () => false), proof: makeAuth().proof }),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }

    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).result.token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).result.token
    // Um agente ATIVO para o membro ver (o Atlas): modelo no catálogo e ativado, e uma chave (de teste) no Claude.
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    await call('/providers/claude/key', { method: 'PUT', token: admin, body: { key: 'sk-ant-teste-00000000' } })
  })

  after(() => {
    delete process.env.SELF_MCP_WRITE
    rmSync(mambaDir, { recursive: true, force: true })
    stop()
  })

  it('sem conta, 401 — o MCP passa pelo mesmo portão da API', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
    assert.strictEqual(res.status, 401)
    assert.strictEqual((await fetch(`${base}/mcp`, { headers: { 'X-Tool-Authorization': `Bearer ${member}` } })).status, 405)
  })

  it('⛔ o membro só vê as ferramentas comuns; o admin vê as de admin e as de escrita (SELF_MCP_WRITE=0 desliga a escrita)', async () => {
    const common = ['get_conversation', 'list_agents', 'list_conversations', 'list_projects', 'my_usage', 'send_message', 'start_conversation', 'switch_model']
    const adminRead = [
      'get_agent',
      'get_agent_initial_context',
      'get_agent_resources',
      'get_doc',
      'get_initial_context',
      'get_protocol',
      'hook_deliveries',
      'list_docs',
      'list_hooks',
      'list_models',
      'list_packages',
      'list_providers',
      'list_resources',
      'list_rules',
      'list_schedules',
      'list_tools',
      'search_packages',
      'usage_by_key',
    ]
    const write = [
      'delete_doc',
      'delete_hook',
      'delete_resource',
      'delete_rule',
      'delete_schedule',
      'install_package',
      'move_rule',
      'remove_package',
      'save_agent',
      'save_doc',
      'save_hook',
      'save_project',
      'save_resource',
      'save_rule',
      'save_schedule',
      'set_agent_initial_context',
      'set_agent_resources',
      'set_initial_context',
      'set_model_enabled',
      'set_model_price',
      'set_project_members',
    ]
    assert.deepStrictEqual(await names(member), common)
    assert.deepStrictEqual(await names(admin), [...common, ...adminRead, ...write].sort())

    process.env.SELF_MCP_WRITE = '0'
    try {
      assert.deepStrictEqual(await names(admin), [...common, ...adminRead].sort())
    } finally {
      delete process.env.SELF_MCP_WRITE
    }
  })

  it('set_model_price grava como preço manual; list_tools mostra locais, nativas e MCPs', async () => {
    const client = await connect(admin)
    const listed = await client.callTool({ name: 'list_models', arguments: { providerId: 'claude' } })
    const model = json(listed)[0]?.modelId ?? 'claude-sonnet-5'
    await client.callTool({ name: 'set_model_price', arguments: { providerId: 'claude', modelId: model, input: 1.5, output: 7.5 } })
    const after = json(await client.callTool({ name: 'list_models', arguments: { providerId: 'claude' } })).find((entry: { modelId: string }) => entry.modelId === model)
    assert.deepStrictEqual([after.price.input, after.price.output, after.priceSource], [1.5, 7.5, 'manual'])

    const tools = json(await client.callTool({ name: 'list_tools', arguments: {} }))
    assert.ok(Array.isArray(tools.local) && Array.isArray(tools.native) && Array.isArray(tools.mcp))
    assert.ok(tools.local.some((tool: { name: string }) => tool.name === 'run_bash'))
  })

  it('list_providers e list_models: só o ativo por padrão; includeDisabled mostra o resto', async () => {
    const client = await connect(admin)
    type TItem = { id?: string; modelId?: string; enabled: boolean }

    const providers = json(await client.callTool({ name: 'list_providers', arguments: {} })) as TItem[]
    const allProviders = json(await client.callTool({ name: 'list_providers', arguments: { includeDisabled: true } })) as TItem[]
    assert.ok(providers.length && providers.every((provider) => provider.enabled))
    // As assinaturas nascem desligadas: só aparecem pedindo.
    assert.ok(allProviders.some((provider) => provider.id === 'claude-sub' && !provider.enabled))

    const models = json(await client.callTool({ name: 'list_models', arguments: { providerId: 'claude' } })) as TItem[]
    const allModels = json(await client.callTool({ name: 'list_models', arguments: { providerId: 'claude', includeDisabled: true } })) as TItem[]
    assert.ok(models.every((model) => model.enabled))
    assert.ok(allModels.length >= models.length)
  })

  it('as ferramentas seguem as regras da API: Atlas Admin só do admin, agentes sem prompt, uso do membro sem custo, uso por chave para o admin', async () => {
    const asMember = await connect(member)
    // O Atlas Admin (`adminOnly`) não aparece para o membro; o Atlas, sim.
    const agents = json(await asMember.callTool({ name: 'list_agents', arguments: {} }))
    assert.deepStrictEqual(
      agents.map((agent: { id: string }) => agent.id),
      ['atlas'],
    )
    assert.ok(agents.every((agent: Record<string, unknown>) => !('systemPrompt' in agent)))

    const mine = await asMember.callTool({ name: 'my_usage', arguments: { days: 7 } })
    assert.ok(!/cost/i.test(JSON.stringify(mine)))

    const byKey = json(await (await connect(admin)).callTool({ name: 'usage_by_key', arguments: { key: 'accountId', days: 30 } }))
    assert.deepStrictEqual(byKey.groups, [])
  })

  it('erro da API vira isError com a mensagem, sem derrubar o cliente', async () => {
    const result = (await (await connect(member)).callTool({ name: 'start_conversation', arguments: { agentId: 'nao-existe' } })) as { isError?: boolean }
    assert.strictEqual(result.isError, true)
    assert.match(json(result).message, /nao-existe/)
  })

  it('install_package instala pela mesma rota da guia Pacotes, e list_packages mostra', async () => {
    const client = await connect(admin)
    const installed = json(await client.callTool({ name: 'install_package', arguments: { name: 'jq' } }))
    assert.strictEqual(installed.ok, true)
    const listed = json(await client.callTool({ name: 'list_packages', arguments: {} }))
    assert.deepStrictEqual(listed.packages, [{ name: 'jq', version: '1.8.2', explicit: true }])
    const refused = await client.callTool({ name: 'install_package', arguments: { name: 'jq; rm -rf /' } })
    assert.strictEqual(refused.isError, true)
  })

  it('⛔ save_hook cria e edita o hook, mas a chave NÃO entra na conversa; list_hooks e delete_hook fecham o ciclo', async () => {
    const client = await connect(admin)
    const created = json(await client.callTool({ name: 'save_hook', arguments: { agentId: 'atlas', name: 'deploy', prompt: 'Resuma o deploy.', verify: 'hmac' } }))
    assert.deepStrictEqual([created.name, created.verify, created.path], ['deploy', 'hmac', '/v1/hook/atlas/deploy'])
    assert.strictEqual(created.secret, undefined)
    assert.match(created.key, /Trocar chave/)
    assert.ok(!JSON.stringify(created).includes('whk_'), 'nenhuma chave na resposta da ferramenta')

    const changed = json(await client.callTool({ name: 'save_hook', arguments: { agentId: 'atlas', name: 'deploy', prompt: 'Outro prompt.', session: 'continuous' } }))
    assert.deepStrictEqual([changed.prompt, changed.session, changed.key], ['Outro prompt.', 'continuous', undefined])
    assert.deepStrictEqual(
      json(await client.callTool({ name: 'list_hooks', arguments: { agentId: 'atlas' } })).map((hook: { name: string }) => hook.name),
      ['deploy'],
    )
    assert.deepStrictEqual(json(await client.callTool({ name: 'hook_deliveries', arguments: { agentId: 'atlas', name: 'deploy' } })), [])
    await client.callTool({ name: 'delete_hook', arguments: { agentId: 'atlas', name: 'deploy' } })
    assert.deepStrictEqual(json(await client.callTool({ name: 'list_hooks', arguments: { agentId: 'atlas' } })), [])
  })

  it('save_rule numera, move_rule reordena (uma posição por chamada) e delete_rule renumera', async () => {
    const client = await connect(admin)
    const titles = async () =>
      json(await client.callTool({ name: 'list_rules', arguments: {} })).map((rule: { position: number; title: string }) => `${rule.position}:${rule.title}`)
    const first = json(await client.callTool({ name: 'save_rule', arguments: { title: 'Idioma', body: 'Português.' } }))
    const second = json(await client.callTool({ name: 'save_rule', arguments: { title: 'Fontes', body: 'Cite a fonte.' } }))
    assert.deepStrictEqual(await titles(), ['1:Idioma', '2:Fontes'])

    const moved = json(await client.callTool({ name: 'move_rule', arguments: { id: second.id, direction: 'up' } }))
    assert.deepStrictEqual(
      moved.map((rule: { title: string }) => rule.title),
      ['Fontes', 'Idioma'],
    )
    await client.callTool({ name: 'delete_rule', arguments: { id: second.id } })
    assert.deepStrictEqual(await titles(), ['1:Idioma'])
    await client.callTool({ name: 'delete_rule', arguments: { id: first.id } })
  })
})
