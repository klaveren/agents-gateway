import { describe, expect, it } from 'vitest'
import { speechEngineOf, speechModelsFor } from './speechCatalog'

describe('speechCatalog', () => {
  it('a Alibaba pelo endereço; o resto é OpenAI', () => {
    expect(speechEngineOf('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')).toBe('dashscope')
    expect(speechEngineOf('https://openrouter.ai/api/v1')).toBe('openai')
    expect(speechEngineOf(undefined)).toBe('openai')
  })
  it('junta os conhecidos com os de voz do catálogo, sem repetir', () => {
    const ids = speechModelsFor('dashscope', ['qwen-plus', 'qwen-audio-3.0-tts-plus', 'cosyvoice-tts-v3']).map((model) => model.id)
    expect(ids).toEqual(['qwen-audio-3.1-tts-flash', 'qwen-audio-3.0-tts-plus', 'cosyvoice-tts-v3'])
  })
})
