import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { generateImage } from './Image.Generator'

const PNG = Buffer.from('png-bytes').toString('base64')

function capture(body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetcher = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('generateImage', () => {
  it('🖼️ compatível com modelo que conversa e gera imagem (Gemini no OpenRouter): chat/completions com modalities', async () => {
    const { calls, fetcher } = capture({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: `data:image/webp;base64,${PNG}` } }] } }] })
    const image = await generateImage(
      { protocol: EProvider.OPENAI, baseUrl: 'https://router.example/v1/', key: 'k' },
      'google/gemini-3.1-flash-image',
      'um gato',
      undefined,
      fetcher,
    )
    assert.strictEqual(calls[0].url, 'https://router.example/v1/chat/completions')
    assert.deepStrictEqual(calls[0].body.modalities, ['image', 'text'])
    assert.deepStrictEqual([image.mime, image.data.toString()], ['image/webp', 'png-bytes'])
  })

  it('⛔ resposta sem data URL (um link de fora) não vira imagem', async () => {
    const { fetcher } = capture({ choices: [{ message: { images: [{ image_url: { url: 'https://cdn.example/x.png' } }] } }] })
    await assert.rejects(generateImage({ protocol: EProvider.OPENAI, baseUrl: 'https://router.example/v1', key: 'k' }, 'v/m-image', 'x', undefined, fetcher), /without an image/)
  })

  it('"só imagem" (gpt-image) segue no endpoint de imagem, oficial ou compatível', async () => {
    const { calls, fetcher } = capture({ data: [{ b64_json: PNG }] })
    await generateImage({ protocol: EProvider.OPENAI, key: 'k' }, 'gpt-image-2', 'x', undefined, fetcher)
    await generateImage({ protocol: EProvider.OPENAI, baseUrl: 'https://compat.example/v1', key: 'k' }, 'gpt-image-2', 'x', undefined, fetcher)
    assert.deepStrictEqual(
      calls.map((call) => call.url),
      ['https://api.openai.com/v1/images/generations', 'https://compat.example/v1/images/generations'],
    )
  })
})
