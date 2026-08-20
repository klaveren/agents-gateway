import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Response } from 'express'
import { SseStream } from './Sse.Stream'

interface IFakeResponse {
  res: Response
  headers: Record<string, string>
  written: string
  ended: boolean
}

function fakeResponse(): IFakeResponse {
  const state: IFakeResponse = { headers: {}, written: '', ended: false } as IFakeResponse

  state.res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value
    },
    flushHeaders() {},
    write(chunk: string) {
      state.written += chunk
      return true
    },
    end() {
      state.ended = true
    },
  } as unknown as Response

  return state
}

describe('SseStream', () => {
  const event = (text: string) => ({ type: 'text.delta', sessionId: 's1', timestamp: new Date(0), payload: { text } }) as const

  it('numbers events so a client can resume from the last id', () => {
    const fake = fakeResponse()
    const stream = new SseStream(fake.res, { heartbeatMs: 0 })

    stream.open()
    stream.send(event('a'))
    stream.send(event('b'))

    assert.match(fake.written, /id: 1\nevent: text\.delta\ndata: /)
    assert.match(fake.written, /id: 2\nevent: text\.delta\ndata: /)
  })

  it('emits heartbeat comments while the turn is quiet', async () => {
    const fake = fakeResponse()
    const stream = new SseStream(fake.res, { heartbeatMs: 5 })

    stream.open()
    await new Promise((resolve) => setTimeout(resolve, 30))
    stream.close()

    assert.ok(fake.written.includes(': ping\n\n'), 'esperava pelo menos um heartbeat')
  })

  it('stops writing once closed', () => {
    const fake = fakeResponse()
    const stream = new SseStream(fake.res, { heartbeatMs: 0 })

    stream.open()
    stream.close()
    stream.send(event('late'))

    assert.strictEqual(fake.written, '')
    assert.strictEqual(fake.ended, true)
  })

  it('closes only once', () => {
    const fake = fakeResponse()
    let ends = 0
    const stream = new SseStream({ ...fake.res, end: () => (ends += 1) } as unknown as Response, { heartbeatMs: 0 })

    stream.open()
    stream.close()
    stream.close()

    assert.strictEqual(ends, 1)
  })
})
