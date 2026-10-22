import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { anthropicReasoning, listModels, parametersReasoning, priceOf } from './Model.Listing'

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('listModels', () => {
  it('formato OpenAI de um compatível: id, nome, contexto e preço por token convertido para 1M', async () => {
    const fetcher = (async () =>
      reply({
        data: [{ id: 'vendor/modelo', name: 'Modelo X', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } }],
      })) as unknown as typeof fetch

    assert.deepStrictEqual(await listModels({ protocol: EProvider.OPENAI, baseUrl: 'https://api.compativel.example/v1' }, 'k', fetcher), [
      { id: 'vendor/modelo', label: 'Modelo X', contextLength: 200000, price: { input: 3, output: 15, cacheRead: 0.3 } },
    ])
  })

  it('OpenAI oficial: tira o que não conversa (embeddings, voz, imagem)', async () => {
    const fetcher = (async () => reply({ data: [{ id: 'gpt-5.6-sol' }, { id: 'text-embedding-3-large' }, { id: 'tts-1' }, { id: 'dall-e-3' }] })) as unknown as typeof fetch

    assert.deepStrictEqual(
      (await listModels({ protocol: EProvider.OPENAI }, 'k', fetcher)).map((model) => model.id),
      ['gpt-5.6-sol'],
    )
  })

  it('Anthropic: segue a paginação por after_id', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(url)
      return url.includes('after_id')
        ? reply({ data: [{ id: 'claude-b', display_name: 'B' }], has_more: false })
        : reply({ data: [{ id: 'claude-a', display_name: 'A' }], has_more: true, last_id: 'claude-a' })
    }) as unknown as typeof fetch

    const models = await listModels({ protocol: EProvider.CLAUDE }, 'k', fetcher)

    assert.deepStrictEqual(
      models.map((model) => [model.id, model.label]),
      [
        ['claude-a', 'A'],
        ['claude-b', 'B'],
      ],
    )
    assert.ok(urls[1].includes('after_id=claude-a'))
  })

  it('Gemini: só os que geram conteúdo, sem o prefixo models/', async () => {
    const fetcher = (async () =>
      reply({
        models: [
          { name: 'models/gemini-3.7-flash', displayName: 'Flash', inputTokenLimit: 1000000, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      })) as unknown as typeof fetch

    assert.deepStrictEqual(await listModels({ protocol: EProvider.GOOGLE }, 'k', fetcher), [{ id: 'gemini-3.7-flash', label: 'Flash', contextLength: 1000000 }])
  })

  it('⛔ erro do provider com a chave mascarada', async () => {
    const fetcher = (async () => reply({ error: { message: 'bad key sk-segredo-9999' } }, 401)) as unknown as typeof fetch

    await assert.rejects(
      listModels({ protocol: EProvider.OPENAI }, 'sk-segredo-9999', fetcher),
      (error: Error) => !error.message.includes('sk-segredo') && error.message.includes('…9999'),
    )
  })

  describe('raciocínio', () => {
    it('Anthropic: os níveis que o `effort` marca como suportados (formato real da listagem)', () => {
      const capabilities = {
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      }
      assert.deepStrictEqual(anthropicReasoning(capabilities), { supported: true, levels: ['low', 'medium', 'high', 'max'], source: 'provider' })
      assert.deepStrictEqual(anthropicReasoning({ thinking: { supported: false }, effort: { supported: false } }), { supported: false, source: 'provider' })
      assert.strictEqual(anthropicReasoning({ citations: { supported: true } }), undefined)
      assert.strictEqual(anthropicReasoning(undefined), undefined)
    })

    it('agregador: `supported_parameters` com reasoning; sem a lista, desconhecido', () => {
      assert.deepStrictEqual(parametersReasoning(['tools', 'reasoning', 'include_reasoning']), { supported: true, source: 'provider' })
      assert.deepStrictEqual(parametersReasoning(['tools', 'temperature']), { supported: false, source: 'provider' })
      assert.strictEqual(parametersReasoning(undefined), undefined)
    })

    it('Gemini: o campo `thinking`', async () => {
      const fetcher = (async () =>
        reply({
          models: [
            { name: 'models/gemini-3.7-flash', thinking: true, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemma', thinking: false },
          ],
        })) as unknown as typeof fetch

      assert.deepStrictEqual(
        (await listModels({ protocol: EProvider.GOOGLE }, 'k', fetcher)).map((model) => model.reasoning?.supported),
        [true, false],
      )
    })

    it('OpenAI oficial: palpite pelo id, marcado heurístico; compatível sem lista fica desconhecido', async () => {
      const fetcher = (async () => reply({ data: [{ id: 'gpt-5.6-sol' }, { id: 'o4-mini' }, { id: 'gpt-4.1' }] })) as unknown as typeof fetch

      assert.deepStrictEqual(
        (await listModels({ protocol: EProvider.OPENAI }, 'k', fetcher)).map((model) => [model.id, model.reasoning]),
        [
          ['gpt-5.6-sol', { supported: true, source: 'heuristic' }],
          ['o4-mini', { supported: true, source: 'heuristic' }],
          ['gpt-4.1', { supported: false, source: 'heuristic' }],
        ],
      )
      assert.strictEqual((await listModels({ protocol: EProvider.OPENAI, baseUrl: 'https://x.example/v1' }, 'k', fetcher))[0].reasoning, undefined)
    })
  })

  it('preço pela metade (sem entrada ou sem saída) não vira preço', () => {
    assert.strictEqual(priceOf({ prompt: '0.000001' }), undefined)
    assert.strictEqual(priceOf({ prompt: 'grátis', completion: '0' }), undefined)
    assert.deepStrictEqual(priceOf({ prompt: '0', completion: '0' }), { input: 0, output: 0 })
  })
})
