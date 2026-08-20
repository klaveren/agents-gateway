import assert from 'node:assert'
import { describe, it } from 'node:test'
import { API_PREFIX, HttpServer } from './Http.Server'
import { OPENAPI_DOCUMENT } from './Openapi.Schema'

/** Express usa `:id`, o OpenAPI usa `{id}`. */
function toOpenapiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}')
}

describe('HttpServer', () => {
  const server = new HttpServer()

  it('serves every route under the version prefix', () => {
    assert.strictEqual(API_PREFIX, '/v1')
    assert.ok(server.routeTable.length > 0)
  })

  it('no longer carries the agentId in the session paths', () => {
    // A sessão já sabe de que agente é; o path repetia a informação sem validá-la.
    assert.ok(server.routeTable.every((route) => !route.path.includes(':agentId/:id')))
    assert.ok(server.routeTable.some((route) => route.path === '/sessions/:id/messages'))
  })

  it('describes every registered route in the OpenAPI document', () => {
    const missing = server.routeTable.filter(({ method, path }) => {
      const described = OPENAPI_DOCUMENT.paths as Record<string, Record<string, unknown>>
      return described[toOpenapiPath(path)]?.[method] === undefined
    })

    assert.deepStrictEqual(missing, [], 'rota registrada e não descrita no OpenAPI')
  })

  it('does not describe routes that do not exist', () => {
    const registered = new Set(server.routeTable.map(({ method, path }) => `${method} ${toOpenapiPath(path)}`))

    const orphans: string[] = []
    for (const [path, operations] of Object.entries(OPENAPI_DOCUMENT.paths)) {
      for (const method of Object.keys(operations)) {
        const key = `${method} ${path}`
        if (!registered.has(key)) orphans.push(key)
      }
    }

    assert.deepStrictEqual(orphans, [], 'descrito no OpenAPI e não registrado')
  })
})
