import assert from 'node:assert'
import { describe, it } from 'node:test'
import { listAccountVoices } from './Voice.Listing'

const KEY = 'sk-chave-secreta-9999'
const conn = { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key: KEY }
const reply = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('listAccountVoices', () => {
  it('🎙️ pede list_voice em voice-enrollment, com a chave só no cabeçalho, e lê id + modelo', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(
        JSON.stringify({
          output: {
            voice_list: [
              { voice_id: 'v1', target_model: 'm1', status: 'OK' },
              { voice_id: 'v2' },
              { voice_id: 'v3', target_model: 'm1', status: 'DEPLOYING' },
              { nope: 1 },
            ],
          },
        }),
      )
    }) as unknown as typeof fetch
    const voices = await listAccountVoices(conn, fetcher)
    assert.deepStrictEqual(voices, [{ id: 'v1', model: 'm1' }, { id: 'v2' }])
    assert.strictEqual(seen!.url, 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization')
    assert.strictEqual(seen!.init.method, 'POST')
    assert.strictEqual(seen!.init.redirect, 'error')
    assert.ok(!seen!.url.includes(KEY))
    assert.strictEqual((seen!.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`)
    assert.deepStrictEqual(JSON.parse(seen!.init.body as string), { model: 'voice-enrollment', input: { action: 'list_voice', page_index: 0, page_size: 100 } })
  })

  it('⚖️ 404, lixo e erro de rede: nenhuma voz, sem lançar, e o aviso não leva a chave', async () => {
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    assert.deepStrictEqual(await listAccountVoices(conn, reply({ message: KEY }, 404) as unknown as typeof fetch, warn), [])
    assert.deepStrictEqual(await listAccountVoices(conn, reply('<html>', 200) as unknown as typeof fetch, warn), [])
    assert.deepStrictEqual(await listAccountVoices(conn, reply({ output: {} }) as unknown as typeof fetch, warn), [])
    const boom = (async () => {
      throw new Error(`falhou com ${KEY}`)
    }) as unknown as typeof fetch
    assert.deepStrictEqual(await listAccountVoices(conn, boom, warn), [])
    assert.strictEqual(warnings.length, 4)
    assert.ok(warnings.every((message) => !message.includes(KEY)))
  })

  it('só DashScope: outro host (ou sem chave) não chama nada', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response('{}')
    }) as unknown as typeof fetch
    assert.strictEqual(await listAccountVoices({ baseUrl: 'https://api.openai.com/v1', key: KEY }, fetcher), undefined)
    assert.strictEqual(await listAccountVoices({ baseUrl: conn.baseUrl }, fetcher), undefined)
    assert.strictEqual(calls, 0)
  })

  it('pagina enquanto a página vem cheia', async () => {
    const pages: number[] = []
    const fetcher = (async (_url: string, init: RequestInit) => {
      const index = JSON.parse(init.body as string).input.page_index as number
      pages.push(index)
      const count = index === 0 ? 100 : 1
      return new Response(JSON.stringify({ output: { voice_list: Array.from({ length: count }, (_, i) => ({ voice_id: `v${index}-${i}` })) } }))
    }) as unknown as typeof fetch
    assert.strictEqual((await listAccountVoices(conn, fetcher))!.length, 101)
    assert.deepStrictEqual(pages, [0, 1])
  })
})
