import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAgents } from '@composition/factories/Agents.Factory'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeLedgerController, makeProvidersController } from '@composition/factories/Controller.Factory'
import { makeTools } from '@composition/factories/Tools.Factory'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { untarGz } from '@infra/catalog/Tar.Archive'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; details?: any }

/**
 * O LEDGER de ponta a ponta: a tela (admin) lê e edita pela API, o agente escreve pela ferramenta (o dono é o do turno),
 * e o índice entra no system prompt — visível no `preview_system_prompt`, como parte própria.
 */
describe('ledger do agente (integração: API de admin, ferramentas, prompt)', () => {
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
    const type = res.headers.get('content-type') ?? ''
    return {
      status: res.status,
      headers: res.headers,
      body: type.includes('json') ? ((await res.json()) as TEnvelope) : undefined,
      raw: type.includes('json') ? undefined : Buffer.from(await res.arrayBuffer()),
    }
  }

  before(async () => {
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeLedgerController(),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body!.result
      .token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body!.result.token
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    for (const id of ['theo', 'ana'])
      makeAgents().save(
        { id, name: id, providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }], systemPrompt: 'faça', modes: [EMode.AGENT], allowedTools: [] },
        { rules: { knownTools: [] }, by: 'seed', creating: true },
      )
  })

  after(() => stop())

  it('⛔ só admin: quem não administra recebe 404 em toda rota do ledger', async () => {
    for (const [method, path] of [
      ['GET', '/agents/theo/ledger'],
      ['GET', '/agents/theo/ledger/export'],
      ['POST', '/agents/theo/ledger/contexts'],
      ['GET', '/agents/theo/ledger/contexts/x/revisions'],
    ] as const)
      assert.strictEqual(
        (await call(path, { method, token: member, ...(method === 'POST' ? { body: { topic: 'x', trigger: 'quando algo acontecer de novo' } } : {}) })).status,
        404,
        path,
      )
    assert.strictEqual((await call('/agents/fantasma/ledger', { token: admin })).status, 404)
  })

  it('a tela cria, edita e apaga; toda escrita devolve o contexto e o índice; a revisão tem o admin como autor', async () => {
    const created = await call('/agents/theo/ledger/contexts', { method: 'POST', token: admin, body: { topic: 'Build OOM', trigger: 'quando o build estourar memória no CI' } })
    assert.strictEqual(created.status, 201)
    assert.strictEqual(created.body!.result.context.topic, 'build-oom')
    assert.strictEqual(created.body!.result.index.contexts.length, 1)

    const invalid = await call('/agents/theo/ledger/contexts', { method: 'POST', token: admin, body: { topic: 'outro', trigger: 'curto' } })
    assert.strictEqual(invalid.status, 422)
    assert.strictEqual(invalid.body!.details[0].field, 'trigger')

    const line = await call('/agents/theo/ledger/contexts/build-oom/lines', {
      method: 'POST',
      token: admin,
      body: { type: 'APRENDIZADO', trigger: 'build no CI', learning: 'subir o heap para 4 GB' },
    })
    assert.strictEqual(line.status, 201)
    const lineId = line.body!.result.context.lines[0].id
    const edited = await call(`/agents/theo/ledger/contexts/build-oom/lines/${lineId}`, { method: 'PUT', token: admin, body: { ref: 'ci.yml' } })
    assert.strictEqual(edited.body!.result.context.lines[0].ref, 'ci.yml')
    const updated = await call('/agents/theo/ledger/contexts/build-oom', { method: 'PUT', token: admin, body: { playbook: '## Heap\n- 4 GB' } })
    assert.strictEqual(updated.body!.result.context.playbook, '## Heap\n- 4 GB')
    assert.strictEqual((await call(`/agents/theo/ledger/contexts/build-oom/lines/${lineId}`, { method: 'DELETE', token: admin })).body!.result.context.lines.length, 0)

    const revisions = (await call('/agents/theo/ledger/contexts/build-oom/revisions', { token: admin })).body!.result
    assert.deepStrictEqual(
      revisions.map((revision: { action: string }) => revision.action),
      ['linha_apagar', 'playbook', 'linha_editar', 'linha_nova', 'criar'],
    )
    assert.deepStrictEqual(revisions[0].by, { kind: 'admin', email: 'root@x.test' })
  })

  it('⛔ o agente escreve pela ferramenta no PRÓPRIO ledger (o do turno); o de outro é recusado', async () => {
    const write = makeTools().catalog.localFor(['ledger_write'])[0]
    const refused = await write.execute(
      { tema: 'build-oom', acao: 'linha_nova', tipo: 'POSTURA', situacao: 'x', aprendizado: 'y', agente: 'theo' },
      { agentId: 'ana', sessionId: 'c-9' },
    )
    assert.strictEqual(refused.status, 'error')
    const own = await write.execute({ tema: 'crm-sync', acao: 'criar', gatilho: 'quando a sincronia do CRM falhar' }, { agentId: 'ana', sessionId: 'c-9' })
    assert.strictEqual(own.status, 'success')
    const index = (await call('/agents/ana/ledger', { token: admin })).body!.result
    assert.deepStrictEqual(
      index.contexts.map((context: { topic: string; createdBy: unknown }) => [context.topic, context.createdBy]),
      [['crm-sync', { kind: 'agent', agentId: 'ana', conversationId: 'c-9' }]],
    )
    assert.deepStrictEqual(
      (await call('/agents/theo/ledger', { token: admin })).body!.result.contexts.map((context: { topic: string }) => context.topic),
      ['build-oom'],
    )
  })

  it('o índice entra no system prompt como parte própria, e as ferramentas no tamanho do agente', async () => {
    const preview = (await call('/agents/theo/system-prompt', { token: admin })).body!.result
    const part = preview.parts.find((item: { key: string }) => item.key === 'ledger')
    assert.ok(part, 'o preview mostra o ledger como parte')
    assert.strictEqual(part.label, 'Índice do ledger')
    assert.ok(preview.prompt.includes('## Ledger — o que você já aprendeu'))
    assert.ok(preview.prompt.includes('- build-oom — quando o build estourar memória no CI'))
    assert.ok(!preview.prompt.includes('subir o heap'), 'o conteúdo do contexto não vai no prompt')
    // `?part=`: só o texto daquela parte; parte que não existe é 422 com as que existem.
    const one = (await call('/agents/theo/system-prompt?part=ledger', { token: admin })).body!.result
    assert.ok(one.part.text.includes('- build-oom — quando o build estourar memória no CI'))
    assert.strictEqual(one.prompt, undefined)
    assert.strictEqual((await call('/agents/theo/system-prompt?part=nada', { token: admin })).status, 422)
    // O ledger da Ana é da Ana.
    assert.ok(!preview.prompt.includes('crm-sync'))

    const footprint = (await call('/agents/theo/footprint', { token: admin })).body!.result
    assert.ok(footprint.sections.some((section: { key: string }) => section.key === 'ledger'))
    const local = footprint.sections.find((section: { key: string }) => section.key === 'local')
    assert.deepStrictEqual(local.items.map((item: { name: string }) => item.name).sort(), ['ledger_read', 'ledger_write'])
  })

  it('export: o `.tar.gz` com a pasta antiga e o `json` com os arquivos', async () => {
    const tar = await call('/agents/theo/ledger/export', { token: admin })
    assert.strictEqual(tar.status, 200)
    assert.match(tar.headers.get('content-disposition') ?? '', /attachment; filename="theo-ledger-\d{4}-\d{2}-\d{2}\.tar\.gz"/)
    const entries = untarGz(tar.raw!)
    assert.deepStrictEqual(entries.map((entry) => entry.path).sort(), ['theo-ledger/contextos/build-oom.md', 'theo-ledger/index.md'])
    const json = await call('/agents/theo/ledger/export?format=json', { token: admin })
    assert.ok(json.body!.result.files['theo-ledger/contextos/build-oom.md'].includes('# @trigger     quando o build estourar memória no CI'))
  })

  it('excluir pela tela: some do índice e do prompt; o histórico fica', async () => {
    const removed = await call('/agents/theo/ledger/contexts/build-oom', { method: 'DELETE', token: admin })
    assert.strictEqual(removed.status, 200)
    assert.deepStrictEqual(removed.body!.result.index.contexts, [])
    const preview = (await call('/agents/theo/system-prompt', { token: admin })).body!.result
    assert.ok(!preview.parts.some((item: { key: string }) => item.key === 'ledger'))
    assert.strictEqual((await call('/agents/theo/ledger/contexts/build-oom', { token: admin })).status, 404)
    assert.strictEqual((await call('/agents/theo/ledger/contexts/build-oom/revisions', { token: admin })).body!.result[0].action, 'excluir')
  })
})
