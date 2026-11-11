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
    useConnectedProjects((projectId) => (projectId === 'logiccus' ? { url: 'http://origem.test' } : undefined))
  })

  after(() => stop())

  it('⛔ escrever no catálogo é recusado (409, project_read_only) com o porquê; ler segue', async () => {
    const refused = await call('PUT', '/resources/banco', { body: 'mudei aqui' })
    assert.deepStrictEqual([refused.status, refused.body.code], [409, 'project_read_only'])
    assert.match(refused.body.message!, /origem.test.*abra um ticket/)
    assert.strictEqual((await call('POST', '/resources', { id: 'nova', kind: 'skill', projectId: 'logiccus', description: 'n', body: 'n' })).status, 409)
    assert.strictEqual((await call('DELETE', '/resources/banco')).status, 409)
    assert.strictEqual((await call('PUT', '/projects/logiccus', { name: 'Outro nome' })).status, 409)
    assert.strictEqual((await call('GET', '/resources/banco')).body.result.body, 'x')
  })

  it('o resto da instalação segue livre: outro projeto e o global', async () => {
    assert.strictEqual((await call('POST', '/resources', { id: 'minha', kind: 'skill', description: 'global', body: 'g' })).status, 201)
  })
})
