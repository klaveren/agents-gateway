import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { synthesizeSpeech } from './Speech.Synthesizer'

const BAILIAN = { protocol: EProvider.OPENAI, baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', key: 'sk-secret' }

interface ICall {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

function scripted(...answers: Response[]) {
  const calls: ICall[] = []
  const fetcher = (async (url: string, init?: ICall['init']) => {
    calls.push({ url, init })
    return answers.shift() ?? new Response('', { status: 500 })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('synthesizeSpeech', () => {
  it('DashScope: pede ao SpeechSynthesizer e baixa o áudio do link, sem a chave', async () => {
    const { calls, fetcher } = scripted(
      new Response(JSON.stringify({ output: { audio: { url: 'https://oss.aliyuncs.com/a.mp3', data: '' }, finish_reason: 'stop' } })),
      new Response(Buffer.from('mp3-bytes'), { headers: { 'content-type': 'audio/mpeg' } }),
    )
    const audio = await synthesizeSpeech(BAILIAN, 'qwen-audio-3.0-tts-plus', 'Olá', { voice: 'Cherry', rate: 1.2 }, fetcher)
    assert.deepStrictEqual([audio.data.toString(), audio.mime], ['mp3-bytes', 'audio/mpeg'])
    assert.strictEqual(calls[0].url, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
    assert.strictEqual(calls[0].init?.headers?.Authorization, 'Bearer sk-secret')
    assert.deepStrictEqual(JSON.parse(calls[0].init?.body ?? '{}'), {
      model: 'qwen-audio-3.0-tts-plus',
      input: { text: 'Olá', voice: 'Cherry', format: 'mp3', rate: 1.2, language_hints: ['pt'] },
    })
    assert.strictEqual(calls[1].url, 'https://oss.aliyuncs.com/a.mp3')
    assert.ok(!JSON.stringify(calls[1].init).includes('sk-secret'))
  })

  it('DashScope: base64 em output.audio.data dispensa o download', async () => {
    const { calls, fetcher } = scripted(new Response(JSON.stringify({ output: { audio: { data: Buffer.from('inline').toString('base64') } } })))
    const audio = await synthesizeSpeech(BAILIAN, 'm', 'x', { voice: 'Cherry', rate: 1 }, fetcher)
    assert.strictEqual(audio.data.toString(), 'inline')
    assert.strictEqual(calls.length, 1)
  })

  it('DashScope: erro sai limpo (sem a chave) e sem voz pede a voz padrão ao admin', async () => {
    const { fetcher } = scripted(new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'bad key sk-secret' }), { status: 401 }))
    await assert.rejects(
      synthesizeSpeech(BAILIAN, 'm', 'x', { voice: 'Cherry', rate: 1 }, fetcher),
      (error: Error) => /bad key \*\*\*/.test(error.message) && !error.message.includes('sk-secret'),
    )
    await assert.rejects(synthesizeSpeech(BAILIAN, 'm', 'x', { rate: 1 }, scripted().fetcher), /default voice/)
  })

  it('⛔ DashScope: link de áudio em host bloqueado ou sem https é recusado', async () => {
    for (const url of ['https://169.254.169.254/a.mp3', 'https://localhost/a.mp3', 'http://oss.aliyuncs.com/a.mp3']) {
      const { calls, fetcher } = scripted(new Response(JSON.stringify({ output: { audio: { url } } })))
      await assert.rejects(synthesizeSpeech(BAILIAN, 'm', 'x', { voice: 'v', rate: 1 }, fetcher), /not allowed/)
      assert.strictEqual(calls.length, 1)
    }
  })

  it('OpenAI: /audio/speech com mp3 e velocidade; voz padrão alloy', async () => {
    const { calls, fetcher } = scripted(new Response(Buffer.from('raw'), { headers: { 'content-type': 'audio/mpeg' } }), new Response(Buffer.from('raw')))
    const audio = await synthesizeSpeech({ protocol: EProvider.OPENAI, key: 'k' }, 'gpt-4o-mini-tts', 'Oi', { rate: 1.5 }, fetcher)
    assert.strictEqual(audio.data.toString(), 'raw')
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/audio/speech')
    assert.deepStrictEqual(JSON.parse(calls[0].init?.body ?? '{}'), { model: 'gpt-4o-mini-tts', input: 'Oi', voice: 'alloy', response_format: 'mp3', speed: 1.5 })
    const other = await synthesizeSpeech({ protocol: EProvider.OPENAI, baseUrl: 'https://compat.example/v1/', key: 'k' }, 'm', 'Oi', { voice: 'nova', rate: 1 }, fetcher)
    assert.strictEqual(other.mime, 'audio/mpeg')
    assert.strictEqual(calls[1].url, 'https://compat.example/v1/audio/speech')
  })

  it('OpenAI: erro HTTP sem a chave; protocolo ou chave ausente recusados', async () => {
    const { fetcher } = scripted(new Response(JSON.stringify({ error: { message: 'no access for k-123' } }), { status: 403 }))
    await assert.rejects(synthesizeSpeech({ protocol: EProvider.OPENAI, key: 'k-123' }, 'm', 'x', { rate: 1 }, fetcher), (error: Error) => !error.message.includes('k-123'))
    await assert.rejects(synthesizeSpeech({ protocol: EProvider.OPENAI }, 'm', 'x', { rate: 1 }), /no API key/)
    await assert.rejects(synthesizeSpeech({ protocol: EProvider.GOOGLE, key: 'k' }, 'm', 'x', { rate: 1 }), /does not speak/)
  })
})
