import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

describe('tela (integração)', () => {
  let origin: string
  let stop: () => void

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const controller = makeController()
    const server = new HttpServer(controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations)).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => stop())

  it('⚠️ o index da tela nova sai com no-cache: senão o navegador segue na versão antiga depois do deploy', async (t) => {
    const res = await fetch(`${origin}/settings`, { headers: { Accept: 'text/html' } })
    const html = await res.text()
    if (!html.includes('id="app"')) return t.skip('web/dist não compilado: a tela antiga responde')

    assert.strictEqual(res.headers.get('cache-control'), 'no-cache')
  })
})
