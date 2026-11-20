import assert from 'node:assert'
import { describe, it } from 'node:test'
import { guessModelSpeech, modelSpeech } from './ModelCatalog.Model'

describe('guessModelSpeech', () => {
  it('🔊 tts e speech geram voz; asr, realtime e transcrição não', () => {
    for (const id of ['qwen-audio-3.0-tts-plus', 'cosyvoice-tts-v3', 'gpt-4o-mini-tts', 'tts-1-hd', 'openai/speech-x'])
      assert.deepStrictEqual(guessModelSpeech(id), { output: true, source: 'heuristic' }, id)
    for (const id of ['qwen-audio-3.0-asr-flash', 'qwen-audio-3.0-realtime-plus', 'gpt-4o-transcribe', 'gpt-5.6', 'tts-realtime', 'speech-asr'])
      assert.strictEqual(guessModelSpeech(id).output, false, id)
  })

  it('modelSpeech: o gravado vale; sem ele, o palpite', () => {
    assert.strictEqual(modelSpeech({ modelId: 'tts-1' }).output, true)
    assert.strictEqual(modelSpeech({ modelId: 'tts-1', speech: { output: false, source: 'listing' } }).output, false)
  })
})
