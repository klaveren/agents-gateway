import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeSessionStore } from '@composition/factories/Orchestrator.Factory'
import {
  makeAuthController,
  makeCatalogController,
  makeController,
  makePermissionRequestsController,
  makeProjectsController,
  makeProvidersController,
} from '@composition/factories/Controller.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

/**
 * ⛔ A TRANCA DE PONTA A PONTA: o agente pede pelo MCP do gateway (com a conta de um admin, como o Atlas), e a aprovação
 * só passa pela sessão da tela (cookie). A mesma conta pelo cabeçalho — o agente, um cliente MCP, um token de acesso — leva 403.
 */
describe('pedidos de permissão (integração: MCP do gateway, API, cookie da tela)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let jar = ''
  let accessToken = ''
  /** A conversa viva do admin (o rótulo do pedido): a de outra pessoa, ou uma que não existe, não fica no pedido. */
  let conversation = ''

  const raw = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await raw(path, init)
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; details?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const bearer = (token: string) => ({ 'X-Tool-Authorization': `Bearer ${token}` })
  const origin = () => `http://${new URL(base).host}`
  let csrf = ''
  /** A tela de verdade: o cookie, a origem, a prova do navegador (`Sec-Fetch-*`) e o CSRF que ela lê do cookie legível. */
  const screen = () => ({ Cookie: jar, Origin: origin(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'X-CSRF': csrf })

  /** O cliente MCP como o gateway o usa: a conta de quem conversa e a identidade do agente (rótulo). */
  const connect = async (token: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    const headers = { ...bearer(token), 'x-gateway-agent': 'theo', 'x-gateway-conversation': conversation }
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }))
    return client
  }
  const texts = (result: unknown) => (result as { content: Array<{ text: string }> }).content.map((part) => part.text)

  before(async () => {
    delete process.env.SELF_MCP_WRITE
    const controller = makeController()
    const server = new HttpServer(
      controller,
      makeAuthController(),
      makeProvidersController(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeProjectsController(),
      undefined,
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
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    const login = await raw('/auth/login', {
      method: 'POST',
      body: { email: 'root@x.test', password: PASSWORD },
      headers: { 'X-Gateway-Client': 'web', Origin: origin() },
    })
    const cookies = login.headers.getSetCookie().map((line) => line.split(';')[0])
    jar = cookies.find((item) => item.startsWith('gw_session_')) ?? ''
    csrf = decodeURIComponent((cookies.find((item) => item.startsWith('gw_csrf_')) ?? '').split('=')[1] ?? '')
    // O modelo do agente ativo: o `patch_agent` grava pelas regras do `PUT` (modelo ativado no catálogo).
    await call('/providers/claude/models', { method: 'POST', headers: bearer(admin), body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', headers: bearer(admin), body: { modelId: 'claude-sonnet-5', enabled: true } })
    accessToken = (await call('/auth/tokens', { method: 'POST', headers: bearer(admin), body: { name: 'ci', expiresInDays: 30 } })).body.result.token
    const me = (await call('/auth/me', { headers: bearer(admin) })).body.result
    conversation = makeSessionStore().create({
      agentId: 'theo',
      provider: 'claude',
      protocol: EProvider.CLAUDE,
      mode: EMode.AGENT,
      model: 'claude-sonnet-5',
      tools: true,
      systemPrompt: 'x',
      metadata: { owner: { id: me.id, email: 'root@x.test' } },
    }).id
    makeAgents().save(
      {
        id: 'theo',
        name: 'Theo',
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
        systemPrompt: 'faça',
        modes: [EMode.AGENT],
        allowedTools: [],
        permissions: [{ category: 'terminal', pattern: 'git status', decision: 'allow' }],
      },
      { rules: { knownTools: [] }, by: 'seed', creating: true },
    )
  })

  after(() => stop())

  let requestId = ''
  let keys: string[] = []

  it('save_permission_rules: a restrição vale já; a ampliação fica pendente, e o resultado manda confirmar na tela', async () => {
    const client = await connect(admin)
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    assert.ok(tools.includes('list_permission_rules') && tools.includes('save_permission_rules'))
    assert.ok(!tools.some((name) => /approve/.test(name)), 'nenhuma ferramenta aprova pedido')
    const description = (await client.listTools()).tools.find((tool) => tool.name === 'save_permission_rules')?.description ?? ''
    assert.match(description, /PENDING until an administrator confirms on the screen/)
    assert.match(description, /never say access was granted/)

    const result = await client.callTool({
      name: 'save_permission_rules',
      arguments: {
        scope: 'agent',
        id: 'theo',
        add: [
          { category: 'network', pattern: '*.evil.com', decision: 'deny' },
          { category: 'terminal', pattern: 'npm test', decision: 'allow' },
        ],
        reason: 'rodar os testes',
      },
    })
    const [notice, json] = texts(result)
    assert.match(notice, /PENDENTE — NÃO aplicado/)
    assert.match(notice, /Agentes → Theo → Permissões → Pedidos pendentes/)
    assert.match(notice, /permite terminal "npm test"/)
    const parsed = JSON.parse(json)
    assert.strictEqual(parsed.pending[0].requestedBy.agentId, 'theo')
    assert.strictEqual(parsed.pending[0].requestedBy.conversationId, conversation)
    requestId = parsed.pending[0].id
    keys = parsed.pending[0].widenings.map((item: { key: string }) => item.key)
    assert.deepStrictEqual(keys, ['agent/theo#permissions+allow:terminal:npm test'])

    const rules = makeAgents().get('theo')?.permissions ?? []
    assert.ok(rules.some((rule) => rule.pattern === '*.evil.com' && rule.decision === 'deny'))
    assert.ok(!rules.some((rule) => rule.pattern === 'npm test'))

    const listed = JSON.parse(texts(await client.callTool({ name: 'list_permission_rules', arguments: { scope: 'agent', id: 'theo' } }))[0])
    assert.deepStrictEqual(
      listed.pending.map((item: { id: string }) => item.id),
      [requestId],
    )
  })

  it('regra inválida pelo MCP: volta com os problemas campo a campo', async () => {
    const client = await connect(admin)
    const result = await client.callTool({
      name: 'save_permission_rules',
      arguments: { scope: 'agent', id: 'theo', add: [{ category: 'terminal', pattern: 'npm **', decision: 'allow' }], reason: 'x' },
    })
    assert.strictEqual((result as { isError?: boolean }).isError, true)
    const error = JSON.parse(texts(result)[0])
    assert.strictEqual(error.status, 422)
    assert.strictEqual(error.details[0].field, 'add[0]')
  })

  it('⛔ aprovar com a conta do admin no CABEÇALHO (o agente, um cliente MCP) é 403; com token de acesso, 403; nada muda', async () => {
    const viaHeader = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: bearer(admin), body: { confirm: keys } })
    assert.strictEqual(viaHeader.status, 403)
    const viaToken = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: bearer(accessToken), body: { confirm: keys } })
    assert.strictEqual(viaToken.status, 403)
    // O cabeçalho vence o cookie: mandar os dois não vira sessão da tela.
    const both = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: { ...screen(), ...bearer(admin) }, body: { confirm: keys } })
    assert.strictEqual(both.status, 403)
    // Cookie sem a origem da tela: a trava de CSRF de sempre.
    const crossSite = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: { Cookie: jar, Origin: 'https://evil.example' }, body: { confirm: keys } })
    assert.strictEqual(crossSite.status, 403)
    // ⛔ O agente que forja o cookie e a origem à mão (curl: Origin = Host, tudo dele) não é a tela: sem a prova do navegador
    // e sem o CSRF (que só quem tem o token calcula), o pedido nem chega a aprovar.
    const forged = { Cookie: jar, Origin: origin() }
    const curl = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: forged, body: { confirm: keys } })
    assert.strictEqual(curl.status, 403)
    const noCsrf = await call(`/permission-requests/${requestId}/approve`, {
      method: 'POST',
      headers: { ...forged, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
      body: { confirm: keys },
    })
    assert.strictEqual(noCsrf.status, 403)
    const wrongCsrf = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: { ...screen(), 'X-CSRF': 'inventado' }, body: { confirm: keys } })
    assert.strictEqual(wrongCsrf.status, 403)
    const crossSiteFetch = await call(`/permission-requests/${requestId}/approve`, {
      method: 'POST',
      headers: { ...screen(), 'Sec-Fetch-Site': 'cross-site' },
      body: { confirm: keys },
    })
    assert.strictEqual(crossSiteFetch.status, 403)
    assert.ok(!(makeAgents().get('theo')?.permissions ?? []).some((rule) => rule.pattern === 'npm test'))
  })

  it('a pessoa na tela (cookie) aprova com as chaves exatas: a regra vale, e a revisão guarda as chaves aceitas', async () => {
    const wrong = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: screen(), body: { confirm: [] } })
    assert.deepStrictEqual([wrong.status, wrong.body.code], [409, 'widening_confirmation_required'])

    const listed = await call('/permission-requests', { headers: screen() })
    assert.deepStrictEqual(
      listed.body.result.map((item: { id: string; status: string }) => [item.id, item.status]),
      [[requestId, 'pending']],
    )

    const approved = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: screen(), body: { confirm: keys } })
    assert.strictEqual(approved.status, 200)
    assert.strictEqual(approved.body.result.request.status, 'approved')
    assert.ok((makeAgents().get('theo')?.permissions ?? []).some((rule) => rule.pattern === 'npm test' && rule.decision === 'allow'))

    const history = await call('/catalog/history?kind=agent&id=theo', { headers: screen() })
    const last = history.body.result.revisions[0]
    assert.deepStrictEqual(last.widenings, keys)
    assert.strictEqual(last.by, 'root@x.test')

    const again = await call(`/permission-requests/${requestId}/approve`, { method: 'POST', headers: screen(), body: { confirm: keys } })
    assert.deepStrictEqual([again.status, again.body.code], [409, 'permission_request_closed'])
  })

  it('recusar: pelo cabeçalho também (recusar não abre nada); o agente fica como estava', async () => {
    const client = await connect(admin)
    const result = await client.callTool({
      name: 'save_permission_rules',
      arguments: { scope: 'agent', id: 'theo', add: [{ category: 'read', pattern: '/etc/**', decision: 'allow' }], reason: 'ler config' },
    })
    const id = JSON.parse(texts(result)[1]).pending[0].id
    const rejected = await call(`/permission-requests/${id}/reject`, { method: 'POST', headers: bearer(admin), body: { note: 'não' } })
    assert.strictEqual(rejected.body.result.status, 'rejected')
    assert.ok(!(makeAgents().get('theo')?.permissions ?? []).some((rule) => rule.pattern === '/etc/**'))
    assert.strictEqual((await call('/agents/theo/permission-requests', { headers: bearer(admin) })).body.result.length, 0)
  })

  it('scope project: a camada do projeto, com o mesmo fluxo (restringe já, amplia pendente, aprova só na tela)', async () => {
    assert.strictEqual((await call('/projects', { method: 'POST', headers: bearer(admin), body: { id: 'alfa', name: 'Alfa' } })).status, 201)
    const client = await connect(admin)
    const result = await client.callTool({
      name: 'save_permission_rules',
      arguments: {
        scope: 'project',
        id: 'alfa',
        add: [
          { category: 'write', pattern: '**/*.lock', decision: 'deny' },
          { category: 'network', pattern: 'registry.npmjs.org', decision: 'allow' },
        ],
        reason: 'instalar pacotes',
      },
    })
    const [notice, json] = texts(result)
    assert.match(notice, /Projeto Alfa → Permissões → Pedidos pendentes/)
    const pending = JSON.parse(json).pending[0]
    assert.deepStrictEqual(
      pending.widenings.map((item: { key: string }) => item.key),
      ['project-permissions/alfa#rules+allow:network:registry.npmjs.org'],
    )
    const listed = JSON.parse(texts(await client.callTool({ name: 'list_permission_rules', arguments: { scope: 'project', id: 'alfa' } }))[0])
    assert.deepStrictEqual([listed.layer, listed.pending.length], ['project', 1])
    assert.deepStrictEqual(
      listed.rules.map((rule: { pattern: string }) => rule.pattern),
      ['**/*.lock'],
    )
    assert.strictEqual((await call('/projects/alfa/permission-requests', { headers: bearer(admin) })).body.result.length, 1)

    const keys = pending.widenings.map((item: { key: string }) => item.key)
    assert.strictEqual((await call(`/permission-requests/${pending.id}/approve`, { method: 'POST', headers: bearer(admin), body: { confirm: keys } })).status, 403)
    const approved = await call(`/permission-requests/${pending.id}/approve`, { method: 'POST', headers: screen(), body: { confirm: keys } })
    assert.strictEqual(approved.status, 200)
    assert.ok(approved.body.result.permissions.some((rule: { pattern: string }) => rule.pattern === 'registry.npmjs.org'))
  })

  it('patch_agent: o que não amplia vale já, a ferramenta nova fica pendente; aprovar só na tela', async () => {
    const client = await connect(admin)
    const result = await client.callTool({
      name: 'patch_agent',
      arguments: { agentId: 'theo', patch: { systemPrompt: 'faça melhor', allowedTools: ['agent:theo-2'] }, reason: 'delegar' },
    })
    // Delegar a um agente que não existe: a validação do PUT vale para o patch inteiro, nada grava.
    assert.strictEqual((result as { isError?: boolean }).isError, true)
    assert.strictEqual(makeAgents().get('theo')?.systemPrompt, 'faça')

    const ok = await client.callTool({
      name: 'patch_agent',
      arguments: { agentId: 'theo', patch: { systemPrompt: 'faça melhor', adminOnly: false, role: 'subagent' }, reason: 'virar subagente' },
    })
    const [notice, json] = texts(ok)
    assert.match(notice, /Nada mudou|Aplicado agora/)
    const parsed = JSON.parse(json)
    assert.deepStrictEqual(parsed.applied.sort(), ['adminOnly', 'role', 'systemPrompt'])
    assert.strictEqual(parsed.pending, undefined)
    assert.strictEqual(makeAgents().entry('theo')?.agent.role, 'subagent')

    const widening = await client.callTool({ name: 'patch_agent', arguments: { agentId: 'theo', patch: { role: null }, reason: 'conversar direto' } })
    const [warn, data] = texts(widening)
    assert.match(warn, /PENDENTE — NÃO aplicado/)
    const pending = JSON.parse(data).pending[0]
    assert.deepStrictEqual(
      pending.widenings.map((item: { key: string }) => item.key),
      ['agent/theo#role-subagent'],
    )
    assert.strictEqual(makeAgents().entry('theo')?.agent.role, 'subagent')
    const keys = pending.widenings.map((item: { key: string }) => item.key)
    assert.strictEqual((await call(`/permission-requests/${pending.id}/approve`, { method: 'POST', headers: bearer(accessToken), body: { confirm: keys } })).status, 403)
    assert.strictEqual((await call(`/permission-requests/${pending.id}/approve`, { method: 'POST', headers: screen(), body: { confirm: keys } })).status, 200)
    assert.strictEqual(makeAgents().entry('theo')?.agent.role, undefined)
  })

  it('get_agent com `fields` devolve só aqueles; preview_system_prompt traz o prompt final e o tamanho por parte', async () => {
    const client = await connect(admin)
    const picked = JSON.parse(texts(await client.callTool({ name: 'get_agent', arguments: { agentId: 'theo', fields: ['permissions'] } }))[0])
    assert.deepStrictEqual(Object.keys(picked).sort(), ['id', 'permissions'])
    const full = JSON.parse(texts(await client.callTool({ name: 'get_agent', arguments: { agentId: 'theo' } }))[0])
    assert.ok('systemPrompt' in full && 'providers' in full)

    // Sem `part`: o RESUMO (o total e as partes, sem o texto).
    const summary = JSON.parse(texts(await client.callTool({ name: 'preview_system_prompt', arguments: { agentId: 'theo', projectId: 'alfa' } }))[0])
    assert.strictEqual(summary.prompt, undefined)
    assert.strictEqual(summary.projectId, 'alfa')
    assert.ok(summary.tokens > 0 && summary.chars > 0)
    assert.deepStrictEqual(
      summary.parts.slice(0, 2).map((part: { key: string }) => part.key),
      ['instructions', 'ambient'],
    )
    // `part`: aquela parte inteira; `all`: o prompt inteiro.
    const one = JSON.parse(texts(await client.callTool({ name: 'preview_system_prompt', arguments: { agentId: 'theo', projectId: 'alfa', part: 'instructions' } }))[0])
    assert.match(one.part.text, /faça melhor/)
    const all = JSON.parse(texts(await client.callTool({ name: 'preview_system_prompt', arguments: { agentId: 'theo', projectId: 'alfa', part: 'all' } }))[0])
    assert.match(all.prompt, /faça melhor/)
    assert.strictEqual(all.chars, summary.chars)
  })

  it('⛔ list_permission_rules: qualquer agente lê as PRÓPRIAS regras (a sessão viva prova quem é); outro agente, projeto ou id forjado, só admin', async () => {
    const memberId = (await call('/users', { method: 'POST', headers: bearer(admin), body: { email: 'bia@x.test', name: 'Bia', password: PASSWORD } })).body.result.id
    const member = (await call('/auth/login', { method: 'POST', body: { email: 'bia@x.test', password: PASSWORD } })).body.result.token
    makeAgents().save(
      {
        id: 'nina',
        name: 'Nina',
        providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
        systemPrompt: 'x',
        modes: [EMode.AGENT],
        allowedTools: [],
        permissions: [],
      },
      { rules: { knownTools: [] }, by: 'seed', creating: true },
    )
    const live = (agentId: string, owner: Record<string, string>, running = true) => {
      const record = makeSessionStore().create({
        agentId,
        provider: 'claude',
        protocol: EProvider.CLAUDE,
        mode: EMode.AGENT,
        model: 'claude-sonnet-5',
        tools: true,
        systemPrompt: 'x',
        metadata: { owner },
      })
      record.status = running ? 'running' : 'idle'
      return record.id
    }
    const theoSession = live('theo', { id: memberId, email: 'bia@x.test' })
    const as = async (token: string, agent: string, conversation: string) => {
      const client = new Client({ name: 'teste', version: '1.0.0' })
      const headers = { ...bearer(token), 'x-gateway-agent': agent, 'x-gateway-conversation': conversation }
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }))
      return async (args: Record<string, unknown>) => {
        const result = (await client.callTool({ name: 'list_permission_rules', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
        return { isError: !!result.isError, body: JSON.parse(result.content[0].text) }
      }
    }

    // O próprio, sem `id` (= eu) e com o id dele: regras, sem ser admin.
    const theo = await as(member, 'theo', theoSession)
    const own = await theo({ scope: 'agent' })
    assert.strictEqual(own.isError, false)
    assert.deepStrictEqual([own.body.agentId, own.body.rules.some((rule: { pattern: string }) => rule.pattern === 'git status')], ['theo', true])
    assert.strictEqual((await theo({ scope: 'agent', id: 'theo' })).body.agentId, 'theo')
    // Outro agente e um projeto: 404 (como sempre para quem não é admin).
    assert.deepStrictEqual([(await theo({ scope: 'agent', id: 'nina' })).isError, (await theo({ scope: 'agent', id: 'nina' })).body.status], [true, 404])
    assert.strictEqual((await theo({ scope: 'project', id: 'alfa' })).body.status, 404)
    // Forjado: o cabeçalho diz nina, a sessão é do theo; a sessão de outra pessoa; a sessão parada; a que não existe.
    assert.strictEqual((await (await as(member, 'nina', theoSession))({ scope: 'agent' })).body.status, 404)
    assert.strictEqual((await (await as(member, 'theo', live('theo', { id: 'outra-pessoa' })))({ scope: 'agent' })).body.status, 404)
    assert.strictEqual((await (await as(member, 'theo', live('theo', { id: memberId }, false)))({ scope: 'agent' })).body.status, 404)
    assert.strictEqual((await (await as(member, 'theo', 'nao-existe'))({ scope: 'agent' })).body.status, 404)
    // Pela API direta, o mesmo: a rota de outro agente com a sessão do theo.
    assert.strictEqual(
      (await call('/agents/nina/permission-rules', { headers: { ...bearer(member), 'x-gateway-agent': 'nina', 'x-gateway-conversation': theoSession } })).status,
      404,
    )
    // Admin: qualquer alvo, como antes (sem sessão viva).
    const byAdmin = await as(admin, 'theo', 'c-42')
    assert.strictEqual((await byAdmin({ scope: 'agent', id: 'nina' })).body.agentId, 'nina')
    assert.strictEqual((await byAdmin({ scope: 'agent' })).body.agentId, 'theo')

    // ⛔ O rótulo com a conversa de OUTRA pessoa (ou uma que não existe) não fica no pedido: o aviso da decisão não entra nela.
    for (const label of [theoSession, 'nao-existe']) {
      const asked = await call('/agents/theo/permission-rules', {
        method: 'POST',
        headers: { ...bearer(admin), 'x-gateway-agent': 'theo', 'x-gateway-conversation': label },
        body: { add: [{ category: 'terminal', pattern: `echo ${label}`, decision: 'allow' }], reason: 'rótulo alheio' },
      })
      assert.strictEqual(asked.status, 200, JSON.stringify(asked.body))
      assert.strictEqual(asked.body.result.pending[0].requestedBy.agentId, 'theo')
      assert.strictEqual(asked.body.result.pending[0].requestedBy.conversationId, undefined)
    }
  })
})
