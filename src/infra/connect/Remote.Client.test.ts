import assert from 'node:assert'
import { describe, it } from 'node:test'
import { RemoteRequestError, RemoteUnavailableError } from '@domain/ports/RemoteCatalog.Port'
import { RemoteClient } from './Remote.Client'

describe('RemoteClient — o que a origem responde não manda aqui', () => {
  const client = (answer: (url: string, init: RequestInit) => Response) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return answer(url, init)
    }) as unknown as typeof fetch
    return { remote: new RemoteClient('http://origem.test:3100', 'logiccus', 'agc_teste', fetchImpl), calls }
  }

  it('⛔ o token não segue um redirecionamento: o pedido não segue, e o erro diz o que fazer', async () => {
    const { remote, calls } = client(() => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }))
    await assert.rejects(remote.version(), (error: unknown) => error instanceof RemoteUnavailableError && /redirecionou/.test(error.message))
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].init.redirect, 'manual')
  })

  it('⛔ o identificador de arquivo que não é um sha256 não entra no caminho do pedido', async () => {
    const { remote, calls } = client(() => Response.json({ ok: true, result: { base64: '' } }))
    await assert.rejects(remote.file('../../version'), RemoteRequestError)
    assert.strictEqual(calls.length, 0)
    await remote.file('a'.repeat(64))
    assert.ok(calls[0].url.endsWith(`/files/${'a'.repeat(64)}`))
  })

  it('⛔ o aviso ao vivo que nunca fecha um quadro é cortado; o quadro bom chega', async () => {
    const versions: number[] = []
    const good = client(() => new Response('event: catalog.version\ndata: {"version":7}\n\n'))
    await good.remote.events((version) => versions.push(version), new AbortController().signal)
    assert.deepStrictEqual(versions, [7])

    const chunk = new TextEncoder().encode('x'.repeat(300_000))
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => (sent++ < 50 ? controller.enqueue(chunk) : controller.close()) })
    const flood = client(() => new Response(endless))
    await assert.rejects(
      flood.remote.events(() => undefined, new AbortController().signal),
      RemoteUnavailableError,
    )
    assert.ok(sent < 10, `leu ${sent} pedaços`)
  })
})
