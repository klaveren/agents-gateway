import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IConversationFile } from '@domain/models/ConversationFile.Model'
import { generateImage } from '@infra/images/Image.Generator'
import { generateImageTool } from './Image.Tool'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const connection = { providerId: 'openai', name: 'OpenAI', protocol: EProvider.OPENAI, key: 'sk-segredo-123' }

function store() {
  const saved: Array<{ file: IConversationFile; data: Buffer }> = []
  return { saved, deliveries: { files: async () => saved.map((item) => item.file), saveFile: async (file: IConversationFile, data: Buffer) => void saved.push({ file, data }) } }
}
const context = { sessionId: 'gw_1', agentId: 'atena', conversationProjectId: 'alfa' } as never

describe('generate_image', () => {
  it('🖼️ gera com o modelo das Configurações e entrega na conversa', async () => {
    const { saved, deliveries } = store()
    const calls: unknown[] = []
    const tool = generateImageTool(
      deliveries,
      { current: async () => ({ connection, model: 'gpt-image-1' }) },
      async (...args) => (calls.push(args.slice(1)), { data: PNG, mime: 'image/png' }),
    )
    const result = await tool.execute({ prompt: 'um farol ao entardecer', name: 'farol', size: '1536x1024' }, context)
    assert.strictEqual(result.status, 'success')
    assert.deepStrictEqual(calls, [['gpt-image-1', 'um farol ao entardecer', '1536x1024']])
    assert.deepStrictEqual([saved[0].file.name, saved[0].file.mime, saved[0].file.agentId], ['farol.png', 'image/png', 'atena'])
  })

  it('sem modelo configurado, fora do projeto ou com o provider caído: diz o motivo e não gera', async () => {
    const { saved, deliveries } = store()
    const never = async () => assert.fail('não devia gerar')
    assert.match(
      (await generateImageTool(deliveries, { current: async () => undefined }, never).execute({ prompt: 'x' }, context)).result as string,
      /No image model is configured/,
    )
    assert.match(
      (await generateImageTool(deliveries, { current: async () => 'openai has no API key' }, never).execute({ prompt: 'x' }, context)).result as string,
      /has no API key/,
    )
    const refused = generateImageTool(deliveries, { current: async () => ({ connection, model: 'gpt-image-1' }), allows: () => false }, never)
    assert.match((await refused.execute({ prompt: 'x' }, context)).result as string, /not released to this project/)
    assert.strictEqual(saved.length, 0)
  })
})

describe('generate_image: o uso', () => {
  const setup = (record: (sessionId: string, entry: unknown) => void) => ({ current: async () => ({ connection, model: 'gpt-image-1' }), record })

  it('📊 anota UMA vez por imagem entregue: agente, projeto da conversa, modelo e os tokens do provider', async () => {
    const { deliveries } = store()
    const recorded: unknown[] = []
    const usage = { inputTokens: 12, outputTokens: 1056, totalTokens: 1068 }
    const tool = generateImageTool(deliveries, setup((...args) => recorded.push(args)), async () => ({ data: PNG, mime: 'image/png', usage }))
    assert.strictEqual((await tool.execute({ prompt: 'um farol' }, context)).status, 'success')
    assert.deepStrictEqual(recorded, [['gw_1', { agentId: 'atena', projectId: 'alfa', provider: 'openai', model: 'gpt-image-1', usage }]])
  })

  it('não anota quando falha (provider, tamanho, limite de arquivos) nem quando é recusada', async () => {
    const { deliveries } = store()
    const recorded: unknown[] = []
    const boom = generateImageTool(deliveries, setup((...args) => recorded.push(args)), async () => Promise.reject(new Error('quota')))
    assert.strictEqual((await boom.execute({ prompt: 'x' }, context)).status, 'error')
    const big = generateImageTool(deliveries, setup((...args) => recorded.push(args)), async () => ({ data: Buffer.alloc(21 * 1024 * 1024), mime: 'image/png' }))
    assert.strictEqual((await big.execute({ prompt: 'x' }, context)).status, 'error')
    const refused = generateImageTool(deliveries, { ...setup((...args) => recorded.push(args)), allows: () => false }, async () => assert.fail('não devia gerar'))
    assert.strictEqual((await refused.execute({ prompt: 'x' }, context)).status, 'error')
    assert.deepStrictEqual(recorded, [])
  })

  it('uma falha ao anotar nunca quebra a ferramenta: a imagem é entregue', async () => {
    const { saved, deliveries } = store()
    const tool = generateImageTool(
      deliveries,
      setup(() => {
        throw new Error('disco cheio')
      }),
      async () => ({ data: PNG, mime: 'image/png' }),
    )
    assert.strictEqual((await tool.execute({ prompt: 'x' }, context)).status, 'success')
    assert.strictEqual(saved.length, 1)
  })
})

describe('Image.Generator: tokens', () => {
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as never
  const b64 = PNG.toString('base64')

  it('OpenAI (images): usage {input_tokens, output_tokens, total_tokens}', async () => {
    const image = await generateImage(connection, 'gpt-image-1', 'gato', '1024x1024', answer({ data: [{ b64_json: b64 }], usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 } }))
    assert.deepStrictEqual(image.usage, { inputTokens: 10, outputTokens: 100, totalTokens: 110 })
  })

  it('OpenRouter (chat): usage {prompt_tokens, completion_tokens}; o total é a soma quando falta', async () => {
    const image = await generateImage(
      { ...connection, baseUrl: 'https://openrouter.ai/api/v1' },
      'google/gemini-2.5-flash-image',
      'gato',
      '1024x1024',
      answer({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }], usage: { prompt_tokens: 7, completion_tokens: 1290 } }),
    )
    assert.deepStrictEqual(image.usage, { inputTokens: 7, outputTokens: 1290, totalTokens: 1297 })
  })

  it('Gemini: usageMetadata {promptTokenCount, candidatesTokenCount, totalTokenCount}', async () => {
    const image = await generateImage(
      { ...connection, protocol: EProvider.GOOGLE },
      'gemini-2.5-flash-image',
      'gato',
      '1024x1024',
      answer({ candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1290, totalTokenCount: 1295 } }),
    )
    assert.deepStrictEqual(image.usage, { inputTokens: 5, outputTokens: 1290, totalTokens: 1295 })
  })

  it('sem usage na resposta, sem `usage` na imagem', async () => {
    assert.strictEqual((await generateImage(connection, 'gpt-image-1', 'gato', '1024x1024', answer({ data: [{ b64_json: b64 }] }))).usage, undefined)
  })
})

describe('Image.Generator', () => {
  it('OpenAI: o endpoint de imagem, a chave só no cabeçalho, o base64 de volta', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetcher = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })))) as never
    const image = await generateImage(connection, 'gpt-image-1', 'gato', '1024x1024', fetcher)
    assert.deepStrictEqual([seen!.url, image.data.equals(PNG)], ['https://api.openai.com/v1/images/generations', true])
    assert.strictEqual((seen!.init.headers as Record<string, string>).Authorization, 'Bearer sk-segredo-123')
    assert.ok(!JSON.parse(String(seen!.init.body)).response_format, 'o gpt-image recusa o campo')
  })

  it('Google: generateContent com saída de imagem; a chave no cabeçalho, nunca na URL', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetcher = (async (url: string, init: RequestInit) => (
      (seen = { url, init }),
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { data: PNG.toString('base64'), mimeType: 'image/png' } }] } }] }))
    )) as never
    const image = await generateImage({ protocol: EProvider.GOOGLE, key: 'g-segredo' }, 'gemini-image', 'gato', '1024x1024', fetcher)
    assert.ok(seen!.url.endsWith('/models/gemini-image:generateContent') && !seen!.url.includes('g-segredo'))
    assert.strictEqual((seen!.init.headers as Record<string, string>)['x-goog-api-key'], 'g-segredo')
    assert.strictEqual(image.mime, 'image/png')
  })

  it('⛔ o erro do provider sai sem a chave', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-segredo-123' } }), { status: 401 })) as never
    await assert.rejects(
      generateImage(connection, 'gpt-image-1', 'x', '1024x1024', fetcher),
      (error: Error) => !error.message.includes('sk-segredo-123') && /\*\*\*/.test(error.message),
    )
  })
})
