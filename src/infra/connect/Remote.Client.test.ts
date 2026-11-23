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

  it('💬 o aviso ao vivo traz as mensagens: `messages.changed` e `message.new` (o torto e o desconhecido são ignorados)', async () => {
    const changed: number[] = []
    const added: Array<{ key: string; body: string }> = []
    const versions: number[] = []
    const frames = [
      'event: catalog.version\ndata: {"type":"catalog.version","version":3}\n\n',
      'event: messages.changed\ndata: {"type":"messages.changed","unread":4}\n\n',
      'event: messages.changed\ndata: {"unread":"x"}\n\n',
      'event: message.new\ndata: {"type":"message.new","id":"m_1","key":"m_1","body":"Posso?","level":"attention","agentId":"maya","conversationId":"c1"}\n\n',
      'event: message.new\ndata: {"id":1}\n\n',
      'event: outro\ndata: {}\n\n',
      'event: message.new\ndata: não é json\n\n',
    ]
    const { remote } = client(() => new Response(frames.join('')))
    await remote.events(
      {
        onVersion: (version) => versions.push(version),
        onMessagesChanged: (event) => changed.push(event.unread),
        onMessageNew: (event) => added.push({ key: event.key, body: event.body }),
      },
      new AbortController().signal,
    )
    assert.deepStrictEqual([versions, changed, added], [[3], [4], [{ key: 'm_1', body: 'Posso?' }]])
  })

  it('💬 as rotas das mensagens: método, caminho e corpo certos, com a data de volta como Date', async () => {
    const { remote, calls } = client(() =>
      Response.json({ ok: true, result: { threads: [{ last: { createdAt: '2026-11-20T10:00:00.000Z' } }], messages: [], unread: 0, pending: 0 } }),
    )
    const listed = await remote.messages(true)
    assert.ok(listed.threads[0].last.createdAt instanceof Date)
    await remote.message('m_1')
    await remote.readMessage('m_1')
    await remote.archiveMessage('m_1', false)
    await remote.setMessageStatus('m_1', 'm_2', 'resolved')
    await remote.replyMessage('c 1', 'oi', 'm_2')
    assert.deepStrictEqual(
      calls.map((call) => [call.init.method, call.url.replace('http://origem.test:3100/v1/connect/logiccus', ''), call.init.body]),
      [
        ['GET', '/messages?archived=1', undefined],
        ['GET', '/messages/m_1', undefined],
        ['POST', '/messages/m_1/read', '{}'],
        ['PUT', '/messages/m_1/archive', '{"archived":false}'],
        ['PUT', '/messages/m_1/m_2/status', '{"status":"resolved"}'],
        ['POST', '/messages/c%201/reply', '{"message":"oi","replyTo":"m_2"}'],
      ],
    )
  })
})
