import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CallerTokenScope } from './Caller.TokenScope'

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `fetch` falso que anota o header de cada requisição. */
function recordingFetch() {
  const seen: (string | null)[] = []
  const base = (async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    return new Response('{}')
  }) as typeof fetch

  return { seen, base }
}

describe('CallerTokenScope', () => {
  it('chamadas simultâneas de pessoas diferentes levam cada uma a sua credencial', async () => {
    const scope = new CallerTokenScope()
    const { seen, base } = recordingFetch()
    const send = scope.wrap(base)

    // A começa, B entra no meio, A só chega ao fetch depois de B — o cenário do vazamento.
    await Promise.all([
      scope.run('token-a', async () => {
        await tick(20)
        await send('http://mcp')
      }),
      scope.run('token-b', async () => {
        await tick(5)
        await send('http://mcp')
      }),
    ])

    assert.deepStrictEqual(seen, ['Bearer token-b', 'Bearer token-a'])
  })

  it('o fim de uma chamada não apaga a credencial de outra ainda em voo', async () => {
    const scope = new CallerTokenScope()
    const { seen, base } = recordingFetch()
    const send = scope.wrap(base)

    await Promise.all([
      scope.run('token-a', async () => {
        await tick(1)
      }),
      scope.run('token-b', async () => {
        await tick(15)
        await send('http://mcp')
      }),
    ])

    assert.deepStrictEqual(seen, ['Bearer token-b'])
  })

  it('sem credencial no escopo, a requisição vai sem header — não herda a anterior', async () => {
    const scope = new CallerTokenScope()
    const { seen, base } = recordingFetch()
    const send = scope.wrap(base)

    await scope.run('token-a', () => send('http://mcp').then(() => undefined))
    await scope.run(undefined, () => send('http://mcp').then(() => undefined))
    await send('http://mcp')

    assert.deepStrictEqual(seen, ['Bearer token-a', null, null])
  })
})
