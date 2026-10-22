import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { apiKeyOf, providerOfModel } from './Classifier.Completion'

describe('providerOfModel', () => {
  it('the registry decides for every model an agent declares', () => {
    for (const agent of AGENT_REGISTRY) for (const model of agent.models) assert.strictEqual(providerOfModel(model), agent.provider)
  })

  it('a model no agent declares falls back to the id prefix', () => {
    assert.strictEqual(providerOfModel('claude-haiku-9'), EProvider.CLAUDE)
    assert.strictEqual(providerOfModel('gemini-9-flash-lite'), EProvider.GOOGLE)
    assert.strictEqual(providerOfModel('gpt-9-mini'), EProvider.OPENAI)
    assert.strictEqual(providerOfModel('o9-mini'), EProvider.OPENAI)
  })

  it('the registry wins over the prefix', () => {
    const agents = [{ ...AGENT_REGISTRY[0], provider: EProvider.OPENAI, models: ['gemini-odd'] }]

    assert.strictEqual(providerOfModel('gemini-odd', agents), EProvider.OPENAI)
  })

  it('an unknown id is no provider, not a guess', () => {
    assert.strictEqual(providerOfModel('llama-9'), undefined)
  })
})

describe('apiKeyOf', () => {
  it('reads the key each provider SDK already uses', () => {
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GOOGLE_API_KEY: 'g' }

    assert.strictEqual(apiKeyOf(EProvider.CLAUDE, env), 'a')
    assert.strictEqual(apiKeyOf(EProvider.OPENAI, env), 'o')
    assert.strictEqual(apiKeyOf(EProvider.GOOGLE, env), 'g')
  })

  it('missing or blank is undefined', () => {
    assert.strictEqual(apiKeyOf(EProvider.CLAUDE, {}), undefined)
    assert.strictEqual(apiKeyOf(EProvider.GOOGLE, { GOOGLE_API_KEY: '  ' }), undefined)
  })
})
