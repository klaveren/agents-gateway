import { describe, expect, it } from 'vitest'
import { speechEngineOf, speechModelsFor } from './speechCatalog'

describe('speechCatalog', () => {
  it('a Alibaba pelo endereço; o resto é OpenAI', () => {
    expect(speechEngineOf('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')).toBe('dashscope')
    expect(speechEngineOf('https://openrouter.ai/api/v1')).toBe('openai')
    expect(speechEngineOf(undefined)).toBe('openai')
  })
  it('só os ativados do provider que geram voz; o conhecido dá a etiqueta e as vozes', () => {
    const models = speechModelsFor('dashscope', ['qwen-plus', 'qwen-audio-3.0-asr-flash', 'qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-tts-plus', 'cosyvoice-tts-v3'])
    expect(models.map((model) => model.id)).toEqual(['qwen-audio-3.0-tts-plus', 'cosyvoice-tts-v3'])
    expect(models[0]!.voices.map((voice) => voice.id)).toEqual(['longanlingxin', 'longanlufeng'])
    expect(models[1]!.voices).toEqual([])
  })
})
