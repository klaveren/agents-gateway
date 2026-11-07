import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAuth } from '@composition/factories/Auth.Factory'
import {
  makeAuthController,
  makeCatalogController,
  makeController,
  makePermissionRequestsController,
  makeProvidersController,
  makeUsageController,
} from '@composition/factories/Controller.Factory'
import { makeProjects } from '@composition/factories/Projects.Factory'
import { makeGuidance } from '@composition/factories/Guidance.Factory'
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
import { PackagesController } from './Packages.Controller'
import { ProjectsController } from './Projects.Controller'
import { turnGrants } from '@infra/tools/Turn.Grants'

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
  // A do composition root: as gravações dela entram no histórico do catálogo (o `catalog_history` lê de lá).
  const guidance = makeGuidance()

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
  let conversations: ReturnType<typeof makeController>['conversations']
  const names = async (token: string) => (await (await connect(token)).listTools()).tools.map((tool) => tool.name).sort()
  const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    delete process.env.SELF_MCP_WRITE
    const controller = makeController()
    conversations = controller.conversations
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
      new ProjectsController({ projects: makeProjects(), proof: makeAuth().proof }),
      new GuidanceController({ guidance, proof: makeAuth().proof }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeCatalogController(),
      makePermissionRequestsController(),
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
    const common = [
      'get_conversation',
      'get_turn',
      'list_agents',
      'list_conversations',
      'list_permission_rules',
      'list_projects',
      'my_usage',
      'send_message',
      'start_conversation',
      'switch_model',
    ]
    const adminRead = [
      'catalog_history',
      'get_agent',
      'get_agent_initial_context',
      'get_agent_resources',
      'get_doc',
      'get_initial_context',
      'get_protocol',
      'hook_deliveries',
      'import_items',
      'list_docs',
      'list_errors',
      'list_hooks',
      'list_model_groups',
      'list_models',
      'list_packages',
      'list_providers',
      'list_resources',
      'list_rules',
      'list_schedules',
      'list_secret_names',
      'list_tools',
      'preview_system_prompt',
      'search_packages',
      'usage_by_key',
    ]
    const write = [
      'attach_resource_files',
      'delete_doc',
      'delete_hook',
      'delete_model_group',
      'delete_resource',
      'delete_rule',
      'delete_schedule',
      'install_package',
      'move_rule',
      'patch_agent',
      'remove_package',
      'request_secret',
      'resolve_import_issue',
      'save_agent',
      'save_doc',
      'save_hook',
      'save_model_group',
      'save_permission_rules',
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
      'share_agent',
      'share_doc',
      'share_resource',
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

  it('⛔ o admin só de projeto vê as ferramentas de admin, menos as de sistema (providers, modelos, pacotes)', async () => {
    const biaId = (await call('/users', { method: 'POST', token: admin, body: { email: 'bia@x.test', name: 'Bia', password: PASSWORD } })).result.id
    makeProjects().create({ id: 'beta-mcp', name: 'Beta' }, 'teste', 'api', biaId)
    const bia = (await call('/auth/login', { method: 'POST', body: { email: 'bia@x.test', password: PASSWORD } })).result.token
    const listed = await names(bia)
    for (const tool of ['list_errors', 'usage_by_key', 'save_agent', 'save_permission_rules', 'save_hook', 'list_secret_names']) assert.ok(listed.includes(tool), tool)
    for (const tool of [
      'list_providers',
      'list_models',
      'list_model_groups',
      'list_packages',
      'search_packages',
      'install_package',
      'remove_package',
      'set_model_enabled',
      'set_model_price',
      'save_model_group',
      'delete_model_group',
    ])
      assert.ok(!listed.includes(tool), tool)
    assert.ok((await names(admin)).includes('list_providers'))
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
    assert.ok(tools.capabilities.some((item: { id: string }) => item.id === 'cap:terminal'))
    assert.ok(!tools.local.some((tool: { name: string }) => tool.name === 'run_bash'))
  })

  it('save_model_group cria e troca UMA sequência sem apagar as outras; delete_model_group recusa a padrão e a que não existe', async () => {
    const client = await connect(admin)
    const step = { provider: 'claude', model: 'claude-sonnet-5' }
    const ok = async (args: Record<string, unknown>) => json(await client.callTool({ name: 'save_model_group', arguments: args }))
    await ok({ id: 'grupo-a', name: 'A', steps: [step] })
    const saved = await ok({ id: 'grupo-b', name: 'B', steps: [step, step], switchOn: ['quota'], cooldownMinutes: 30 })
    assert.deepStrictEqual(
      saved.modelGroups.map((group: { id: string }) => group.id),
      ['grupo-a', 'grupo-b'],
    )
    await ok({ id: 'grupo-a', name: 'A2', steps: [step] })
    const listed = json(await client.callTool({ name: 'list_model_groups', arguments: {} }))
    assert.deepStrictEqual(
      listed.modelGroups.map((group: { id: string; name: string }) => [group.id, group.name]),
      [
        ['grupo-a', 'A2'],
        ['grupo-b', 'B'],
      ],
    )
    assert.deepStrictEqual([listed.modelGroups[1].switchOn, listed.modelGroups[1].cooldownMinutes], [['quota'], 30])

    // A validação da tela vale: provider que não existe não entra, e nada é gravado.
    const bad = await client.callTool({ name: 'save_model_group', arguments: { id: 'grupo-c', name: 'C', steps: [{ provider: 'nao-existe', model: 'claude-sonnet-5' }] } })
    assert.strictEqual(bad.isError, true)
    assert.strictEqual(json(await client.callTool({ name: 'list_model_groups', arguments: {} })).modelGroups.length, 2)

    // Padrão não sai; a que não existe é recusada; a livre sai.
    await call('/settings', { method: 'PUT', token: admin, body: { defaultModelGroup: 'grupo-a' } })
    assert.strictEqual((await client.callTool({ name: 'delete_model_group', arguments: { id: 'grupo-a' } })).isError, true)
    assert.strictEqual((await client.callTool({ name: 'delete_model_group', arguments: { id: 'zzz-nao' } })).isError, true)
    const left = json(await client.callTool({ name: 'delete_model_group', arguments: { id: 'grupo-b' } }))
    assert.deepStrictEqual(
      left.modelGroups.map((group: { id: string }) => group.id),
      ['grupo-a'],
    )

    // Quem não é admin do gateway nem vê a ferramenta.
    assert.ok(!(await names(member)).includes('save_model_group'))
    await call('/settings', { method: 'PUT', token: admin, body: { defaultModelGroup: null, modelGroups: null } })
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

  it('⛔ chamado por um agente (identidade no header), o MCP não oferece as ferramentas de conversa', async () => {
    const client = new Client({ name: 'agente', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Tool-Authorization': `Bearer ${admin}`, 'x-gateway-agent': 'agent-x' } } }),
    )
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of ['start_conversation', 'send_message', 'get_turn']) assert.strictEqual(listed.includes(name), false, name)
    assert.strictEqual(listed.includes('list_agents'), true)
  })

  it('get_turn de conversa que não existe vira isError, sem esperar', async () => {
    const result = (await (await connect(member)).callTool({ name: 'get_turn', arguments: { sessionId: 'nao-existe', turn: 0, waitSeconds: 5 } })) as { isError?: boolean }
    assert.strictEqual(result.isError, true)
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

  it('share_doc e share_resource chamam as rotas de compartilhar; o agente (identidade no header) é recusado, a pessoa passa', async () => {
    const client = await connect(admin)
    for (const id of ['orig-mcp', 'dest-mcp']) await client.callTool({ name: 'save_project', arguments: { id, name: id } })
    await client.callTool({ name: 'save_doc', arguments: { id: 'guia-mcp', kind: 'knowledge', projectId: 'orig-mcp', title: 'Guia', summary: 's', body: 'b' } })
    await client.callTool({ name: 'save_resource', arguments: { id: 'skill-mcp', kind: 'skill', projectId: 'orig-mcp', description: 'D', body: 'b' } })

    const doc = json(await client.callTool({ name: 'share_doc', arguments: { id: 'guia-mcp', projects: ['dest-mcp'] } }))
    const resource = json(await client.callTool({ name: 'share_resource', arguments: { id: 'skill-mcp', projects: ['dest-mcp'] } }))
    assert.deepStrictEqual([doc.sharedWith, resource.sharedWith], [['dest-mcp'], ['dest-mcp']])
    // O que a API manda (`sharedFrom`) é o que list_docs / list_resources mostram.
    const seen = json(await client.callTool({ name: 'list_docs', arguments: { projectId: 'dest-mcp' } }))
    assert.ok(seen.some((item: { id: string; sharedFrom?: string }) => item.id === 'guia-mcp' && item.sharedFrom === 'orig-mcp'))

    // ⛔ O agente da conversa não compartilha, nem com o projeto dele.
    const agent = new Client({ name: 'agente', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { 'X-Tool-Authorization': `Bearer ${admin}`, 'x-gateway-agent': 'agent-x', 'x-gateway-project': 'orig-mcp' } },
      }),
    )
    for (const [name, id] of [
      ['share_doc', 'guia-mcp'],
      ['share_resource', 'skill-mcp'],
    ]) {
      const refused = (await agent.callTool({ name, arguments: { id, projects: [] } })) as { isError?: boolean }
      assert.strictEqual(refused.isError, true, name)
    }
    assert.deepStrictEqual(json(await client.callTool({ name: 'get_doc', arguments: { id: 'guia-mcp' } })).sharedWith, ['dest-mcp'])
  })

  it('⚖️ save_doc sem teto: 300 KB passa pelo MCP e pela API, e get_doc devolve inteiro', async () => {
    const client = await connect(admin)
    const big = 'x'.repeat(300_000)
    const saved = (await client.callTool({ name: 'save_doc', arguments: { id: 'enorme', kind: 'spec', title: 'Enorme', summary: 'grande', body: big } })) as { isError?: boolean }
    assert.ok(!saved.isError, JSON.stringify(saved).slice(0, 300))
    // A gravação não ecoa o corpo: volta o tamanho; o texto se lê com get_doc.
    assert.strictEqual(json(saved).body, '[300000 caracteres]')
    assert.strictEqual(json(await client.callTool({ name: 'get_doc', arguments: { id: 'enorme' } })).body, big)
  })

  it('catalog_history: lista as revisões, mostra uma, compara e volta (uma revisão NOVA, nada apagado)', async () => {
    const client = await connect(admin)
    const save = (body: string) => client.callTool({ name: 'save_doc', arguments: { id: 'historico', kind: 'spec', title: 'Histórico', summary: 's', body } })
    await save('versão um')
    await save('versão dois')
    const history = (args: Record<string, unknown>) =>
      client.callTool({ name: 'catalog_history', arguments: { kind: 'spec', id: 'historico', ...args } }) as Promise<{ isError?: boolean }>
    const listed = json(await history({ action: 'list' }))
    const numbers = (listed.revisions as Array<{ revision: number }>).map((one) => one.revision)
    assert.deepStrictEqual(numbers, [2, 1])
    assert.match(JSON.stringify(json(await history({ action: 'show', revision: 1 }))), /versão um/)
    assert.match(JSON.stringify(json(await history({ action: 'diff', from: 1 }))), /versão dois/)
    assert.ok((await history({ action: 'restore', revision: 1 })).isError, 'sem expectedRevision, recusa')
    assert.ok((await history({ action: 'restore', revision: 1, expectedRevision: 1 })).isError, 'revisão velha: alguém mexeu depois')
    const restored = await history({ action: 'restore', revision: 1, expectedRevision: 2 })
    assert.ok(!restored.isError, JSON.stringify(restored).slice(0, 300))
    assert.strictEqual(json(await client.callTool({ name: 'get_doc', arguments: { id: 'historico' } })).body, 'versão um')
    assert.deepStrictEqual(
      (json(await history({ action: 'list' })).revisions as Array<{ revision: number }>).map((one) => one.revision),
      [3, 2, 1],
    )
  })

  it('⚖️ list_resources sem id é o ÍNDICE (sem os corpos); com id, o recurso inteiro', async () => {
    const client = await connect(admin)
    const body = 'passo '.repeat(5_000)
    const saved = (await client.callTool({ name: 'save_resource', arguments: { id: 'revisar-pr', kind: 'skill', description: 'Revisa um pull request', body } })) as {
      isError?: boolean
    }
    assert.ok(!saved.isError, JSON.stringify(saved).slice(0, 300))
    const index = json(await client.callTool({ name: 'list_resources', arguments: { kind: 'skill' } }))
    const entry = index.find((one: { id: string }) => one.id === 'revisar-pr')
    assert.deepStrictEqual(entry, { id: 'revisar-pr', kind: 'skill', description: 'Revisa um pull request', bodyChars: body.length })
    assert.ok(!JSON.stringify(index).includes('passo passo'), 'o corpo não vem no índice')
    assert.strictEqual(json(await client.callTool({ name: 'list_resources', arguments: { id: 'revisar-pr' } })).body, body)
  })

  it('get_doc traz os problemas da importação, e resolve_import_issue tira um (pela mesma rota da tela)', async () => {
    guidance.createDoc(
      {
        id: 'importado',
        kind: 'spec',
        title: 'Importado',
        summary: '',
        body: 'x'.repeat(5_000),
        importIssues: [
          { code: 'link-missing', message: 'cita memoria, que não existe', target: 'memoria', link: 'attach' },
          { code: 'link-pending', message: 'vínculo com api pendente', target: 'api', link: 'attach' },
        ],
      },
      'import',
    )
    const client = await connect(admin)
    const codes = async () => (json(await client.callTool({ name: 'get_doc', arguments: { id: 'importado' } })).importIssues ?? []).map((one: { code: string }) => one.code)
    assert.deepStrictEqual(await codes(), ['link-missing', 'link-pending'])
    const resolved = (await client.callTool({ name: 'resolve_import_issue', arguments: { kind: 'doc', id: 'importado', code: 'link-missing', target: 'memoria' } })) as {
      isError?: boolean
    }
    assert.ok(!resolved.isError, JSON.stringify(resolved))
    // ⚖️ A resposta é o item sem os textos longos (o agente inteiro estourava a resposta a cada chamada).
    assert.strictEqual(json(resolved).body, '[5000 caracteres]')
    assert.deepStrictEqual(
      json(resolved).importIssues.map((one: { code: string }) => one.code),
      ['link-pending'],
    )
    assert.deepStrictEqual(await codes(), ['link-pending'])
    const again = (await client.callTool({ name: 'resolve_import_issue', arguments: { kind: 'doc', id: 'importado', code: 'link-missing' } })) as { isError?: boolean }
    assert.strictEqual(again.isError, true)
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
  it('⛔ o agente chega pela CONCESSÃO do turno (sem token) e só grava no projeto da conversa dele', async () => {
    for (const id of ['proja', 'projb']) await call('/projects', { method: 'POST', token: admin, body: { id, name: id } })
    const grant = turnGrants().register({ tools: [], context: { token: admin, agentId: 'atlas', sessionId: 's1', conversationProjectId: 'proja' } })
    try {
      const client = new Client({ name: 'teste', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Turn-Grant': grant } } }))

      const other = (await client.callTool({ name: 'save_rule', arguments: { title: 'Invasora', body: 'x', projectId: 'projb' } })) as { isError?: boolean }
      assert.strictEqual(other.isError, true)
      assert.strictEqual(json(other).status, 403)
      const global = (await client.callTool({ name: 'save_rule', arguments: { title: 'Global', body: 'x' } })) as { isError?: boolean }
      assert.strictEqual(global.isError, true)
      const own = await client.callTool({ name: 'save_rule', arguments: { title: 'Do projeto', body: 'x', projectId: 'proja' } })
      assert.ok(!(own as { isError?: boolean }).isError, JSON.stringify(own))
      const ruleId = json(own).id as string
      // A regra do projeto da conversa muda; a de outro projeto, mesmo existindo, não.
      const foreign = json(await (await connect(admin)).callTool({ name: 'save_rule', arguments: { title: 'De B', body: 'x', projectId: 'projb' } })).id as string
      assert.strictEqual(((await client.callTool({ name: 'delete_rule', arguments: { id: foreign } })) as { isError?: boolean }).isError, true)
      assert.ok(!((await client.callTool({ name: 'delete_rule', arguments: { id: ruleId } })) as { isError?: boolean }).isError)
    } finally {
      turnGrants().release(grant)
    }
    // Acabou o turno: a concessão não abre mais nada.
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'X-Turn-Grant': grant, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}',
    })
    assert.strictEqual(after.status, 401)
  })

  it('⛔ save_agent por AGENTE: nasce no projeto da conversa, no mínimo; o que amplia vira pedido; omitir projectId mantém o projeto', async () => {
    await call('/projects', { method: 'POST', token: admin, body: { id: 'projsave', name: 'projsave' } })
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    const grant = turnGrants().register({ tools: [], context: { token: admin, agentId: 'atlas', sessionId: 's2', conversationProjectId: 'projsave' } })
    try {
      const client = new Client({ name: 'teste', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Turn-Grant': grant } } }))
      const agent = {
        id: 'filho-save',
        name: 'Filho',
        providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
        systemPrompt: 'Você ajuda.',
        modes: ['agent'],
        allowedTools: ['run_bash'],
        adminOnly: false,
      }
      const created = await client.callTool({ name: 'save_agent', arguments: agent })
      assert.ok(!(created as { isError?: boolean }).isError, JSON.stringify(created))
      const stored = (await call('/agents/filho-save', { token: admin })).result
      assert.strictEqual(stored.projectId, 'projsave', 'sem projectId nasce no projeto da conversa')
      assert.ok(!(stored.allowedTools ?? []).length, 'run_bash não foi gravado')
      assert.strictEqual(stored.adminOnly, true)
      const pending = (await call('/agents/filho-save/permission-requests', { token: admin })).result as Array<{ kind: string }>
      assert.ok(
        pending.some((request) => request.kind === 'agent-patch'),
        JSON.stringify(pending),
      )

      // Editar sem projectId mantém o projeto; pedir a ferramenta de novo não a grava.
      const edited = await client.callTool({ name: 'save_agent', arguments: { ...agent, name: 'Filho 2', allowedTools: ['run_bash'] } })
      assert.ok(!(edited as { isError?: boolean }).isError, JSON.stringify(edited))
      const after = (await call('/agents/filho-save', { token: admin })).result
      assert.deepStrictEqual([after.name, after.projectId, (after.allowedTools ?? []).length], ['Filho 2', 'projsave', 0])
    } finally {
      turnGrants().release(grant)
    }

    // Pessoa direto pelo MCP: grava na hora e, sem projectId, não derruba o agente de projeto para global.
    const person = await connect(admin)
    const saved = await person.callTool({
      name: 'save_agent',
      arguments: {
        id: 'filho-save',
        name: 'Filho 3',
        providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
        systemPrompt: 'Você ajuda.',
        modes: ['agent'],
        allowedTools: ['run_bash'],
      },
    })
    assert.ok(!(saved as { isError?: boolean }).isError, JSON.stringify(saved))
    const final = (await call('/agents/filho-save', { token: admin })).result
    assert.strictEqual(final.projectId, 'projsave')
    assert.ok(final.allowedTools.length > 0, 'a pessoa grava na hora')
  })

  it('list_conversations: `all` é o monitor paginado (q busca texto, não metadado); sem `all`, q filtra as próprias; o agente fica no projeto dele', async () => {
    for (const id of ['la', 'lb']) await call('/projects', { method: 'POST', token: admin, body: { id, name: id } })
    // Conversas gravadas (a lista é do histórico, não das vivas): uma por projeto, com título para a busca.
    const me = (await call('/auth/me', { token: admin })).result
    const open = async (projectId: string, title: string) => {
      const id = `lc-${projectId}-${title}`
      const at = new Date()
      await conversations.saveSession({
        id,
        agentId: 'atlas',
        provider: 'claude',
        mode: 'chat',
        model: 'claude-sonnet-5',
        title,
        createdAt: at,
        updatedAt: at,
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
        metadata: { project: projectId, owner: { id: me.id, ...(me.account ? { account: me.account } : {}), email: me.email } },
      })
      return id
    }
    const [inA, inB] = [await open('la', 'faturamento-mensal'), await open('lb', 'outro-assunto')]
    const asAdmin = await connect(admin)
    const list = async (client: Client, args: Record<string, unknown>) => json(await client.callTool({ name: 'list_conversations', arguments: args }))
    const ids = (listed: { sessions: Array<{ id: string }> }) => listed.sessions.map((session) => session.id)

    // O monitor: traz as de todos do que se administra, com total e página; o `q` é busca de texto (id), não metadado.
    const all = await list(asAdmin, { all: true, projectId: 'la' })
    assert.deepStrictEqual(ids(all), [inA])
    assert.strictEqual(all.page, 1)
    assert.strictEqual(all.total, 1)
    assert.deepStrictEqual(ids(await list(asAdmin, { all: true, q: 'outro-assunto' })), [inB])
    assert.deepStrictEqual(ids(await list(asAdmin, { all: true, q: 'nada-assim-existe' })), [])

    // Sem `all`, `q` não vira filtro de metadado (antes esvaziava a lista): corta por título/id.
    const mine = (await list(asAdmin, { q: 'FATURAMENTO' })) as unknown as Array<{ id: string }>
    assert.deepStrictEqual(
      mine.map((session) => session.id),
      [inA],
    )

    // O membro não é admin: `all` é 404, como na API.
    assert.strictEqual(json(await (await connect(member)).callTool({ name: 'list_conversations', arguments: { all: true } })).status, 404)

    // O agente (concessão) em `la` vê o monitor só de `la`, mesmo pedindo `lb`.
    const grant = turnGrants().register({ tools: [], context: { token: admin, agentId: 'atlas', sessionId: inA, conversationProjectId: 'la' } })
    try {
      const client = new Client({ name: 'teste', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Turn-Grant': grant } } }))
      assert.deepStrictEqual(ids(await list(client, { all: true })), [inA])
      assert.deepStrictEqual(ids(await list(client, { all: true, projectId: 'lb' })), [inA], 'o projeto pedido não escapa do da origem')
    } finally {
      turnGrants().release(grant)
    }
  })

  it('⛔ o agente (concessão) só alcança conversas do PROJETO da conversa dele: ler, mandar mensagem e reconfigurar em outro projeto são recusados', async () => {
    for (const id of ['pa', 'pb']) await call('/projects', { method: 'POST', token: admin, body: { id, name: id } })
    const open = async (projectId?: string) => {
      const created = await call('/sessions', { method: 'POST', token: admin, body: { agentId: 'atlas', provider: 'claude', ...(projectId ? { projectId } : {}) } })
      assert.ok(created.result?.id, JSON.stringify(created))
      return created.result.id as string
    }
    const [own, other, none] = [await open('pa'), await open('pb'), await open()]
    const grant = turnGrants().register({ tools: [], context: { token: admin, agentId: 'atlas', sessionId: own, conversationProjectId: 'pa' } })
    try {
      const client = new Client({ name: 'teste', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Turn-Grant': grant } } }))
      const run = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean }

      for (const target of [other, none]) {
        assert.strictEqual(json(await run('send_message', { sessionId: target, message: 'oi', waitSeconds: 0 })).status, 403, 'send_message')
        assert.strictEqual(json(await run('get_turn', { sessionId: target, turn: 0, waitSeconds: 0 })).status, 403, 'get_turn')
        assert.strictEqual(json(await run('get_conversation', { sessionId: target })).status, 403, 'get_conversation')
        assert.strictEqual(json(await run('switch_model', { sessionId: target, reasoning: null })).status, 403, 'PATCH /sessions/:id')
      }
      // A do próprio projeto segue (aqui só provamos que não é a recusa de projeto).
      const mine = await run('get_conversation', { sessionId: own })
      assert.notStrictEqual(json(mine).status, 403, JSON.stringify(mine))
    } finally {
      turnGrants().release(grant)
    }
  })
})
