import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeGuidanceController, makeProjectsController, makeProvidersController } from '@composition/factories/Controller.Factory'
import { useConnectedProjects } from '@composition/factories/Projects.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TEnvelope = { ok: boolean; result?: any; code?: string; message?: string }

/** 🔌 O PROJETO CONECTADO É SÓ LEITURA: a tela e a API leem; escrever no catálogo dele é recusado com o porquê. */
describe('projeto conectado: só leitura (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Tool-Authorization': `Bearer ${admin}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as TEnvelope }
  }

  before(async () => {
    const u = undefined
    const server = new HttpServer(makeController(), makeAuthController(), makeProvidersController(), u, u, u, u, u, makeProjectsController(), makeGuidanceController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
      useConnectedProjects(() => undefined)
    }
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD }),
    })
    admin = ((await setup.json()) as TEnvelope).result.token
    assert.strictEqual((await call('POST', '/projects', { id: 'logiccus', name: 'Logiccus' })).status, 201)
    assert.strictEqual((await call('POST', '/resources', { id: 'banco', kind: 'skill', projectId: 'logiccus', description: 'Banco', body: 'x' })).status, 201)
    // O agente que pede um grupo (antes de conectar: o catálogo do conectado só muda pela origem).
    await call('POST', '/providers/claude/models', { modelId: 'claude-sonnet-5' })
    await call('PUT', '/providers/claude/models', { modelId: 'claude-sonnet-5', enabled: true })
    const step = { provider: 'claude', model: 'claude-sonnet-5' }
    assert.strictEqual((await call('PUT', '/projects/logiccus/model-groups', { groups: [{ id: 'executor-low', name: 'Executor', steps: [step] }] })).status, 200)
    const agent = {
      id: 'maya',
      name: 'Maya',
      projectId: 'logiccus',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: ['chat'],
      allowedTools: [],
      modelGroup: 'executor-low',
    }
    assert.strictEqual((await call('POST', '/agents', agent)).status, 201)
    useConnectedProjects((projectId) => (projectId === 'logiccus' ? { url: 'http://origem.test' } : undefined))
  })

  after(() => stop())

  it('⛔ escrever no catálogo é recusado (409, project_read_only) com o porquê; ler segue', async () => {
    const refused = await call('PUT', '/resources/banco', { body: 'mudei aqui' })
    assert.deepStrictEqual([refused.status, refused.body.code], [409, 'project_read_only'])
    assert.match(refused.body.message!, /origem.test.*feita na origem/)
    assert.strictEqual((await call('POST', '/resources', { id: 'nova', kind: 'skill', projectId: 'logiccus', description: 'n', body: 'n' })).status, 409)
    assert.strictEqual((await call('DELETE', '/resources/banco')).status, 409)
    assert.strictEqual((await call('PUT', '/projects/logiccus', { name: 'Outro nome' })).status, 409)
    assert.strictEqual((await call('GET', '/resources/banco')).body.result.body, 'x')
  })

  it('🔌 os grupos de modelos e o modelo padrão são desta máquina: graváveis no conectado; o grupo que falta vira alerta', async () => {
    const step = { provider: 'claude', model: 'claude-sonnet-5' }
    // Tirar o grupo que um agente pede não é recusado no conectado: vira "não configurado nesta máquina".
    const cleared = await call('PUT', '/projects/logiccus/model-groups', { groups: [], defaultModel: step })
    assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body))
    assert.deepStrictEqual(cleared.body.result.defaultModel, step)
    const view = (await call('GET', '/projects/logiccus/model-groups')).body.result
    assert.strictEqual(view.connected, true)
    assert.deepStrictEqual(view.missing, [{ id: 'executor-low', agents: ['maya'] }])
    assert.deepStrictEqual(view.requested, [{ id: 'executor-low', agents: ['maya'], configured: null }])

    // O passo que não roda aqui aparece com o motivo; o grupo configurado sai do alerta.
    const saved = await call('PUT', '/projects/logiccus/model-groups', { groups: [{ id: 'executor-low', name: 'Executor', steps: [step] }] })
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body))
    assert.deepStrictEqual([saved.body.result.missing, saved.body.result.requested[0].configured, saved.body.result.defaultModel], [[], 'project', step])
    await call('PUT', '/providers/claude/models', { modelId: 'claude-sonnet-5', enabled: false })
    const off = (await call('GET', '/projects/logiccus/model-groups')).body.result
    assert.deepStrictEqual(off.unavailable, { 'executor-low': [{ index: 0, provider: 'claude', model: 'claude-sonnet-5', reason: 'model-disabled' }] })
    assert.strictEqual(off.defaultModelUnavailable, 'model-disabled')
    await call('PUT', '/providers/claude/models', { modelId: 'claude-sonnet-5', enabled: true })
  })

  it('o resto da instalação segue livre: outro projeto e o global', async () => {
    assert.strictEqual((await call('POST', '/resources', { id: 'minha', kind: 'skill', description: 'global', body: 'g' })).status, 201)
  })
})
