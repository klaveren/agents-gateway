/**
 * 🔊 O QUE ESCOLHER NA VOZ (Ajustes → Voz): os modelos e as vozes conhecidos de cada motor, para a tela oferecer uma lista
 * em vez de um campo em branco. ⚖️ É só ajuda: o modelo do catálogo do provider com "tts", "audio" ou "speech" no nome
 * também entra, e "Outro…" aceita qualquer id. As línguas vêm da documentação de cada provider (Alibaba: lista de vozes do
 * Qwen-Audio-TTS; OpenAI: audio/speech).
 */
export type TSpeechEngine = 'dashscope' | 'openai'

export interface ISpeechVoice {
  id: string
  label: string
}

export interface ISpeechModel {
  id: string
  label: string
  voices: ISpeechVoice[]
}

/** O motor pelo endereço do provider: a Alibaba (DashScope) tem API própria; o resto fala o `audio/speech` da OpenAI. */
export function speechEngineOf(baseUrl: string | undefined): TSpeechEngine {
  try {
    const host = baseUrl ? new URL(baseUrl).hostname.toLowerCase() : ''
    return host.endsWith('.aliyuncs.com') || host.endsWith('.qwencloudapi.com') ? 'dashscope' : 'openai'
  } catch {
    return 'openai'
  }
}

const QWEN_31_FLASH: ISpeechVoice[] = [
  { id: 'qwen-audio-3.1-tts-flash-aurora_pt_br', label: 'Aurora · português do Brasil, masculina' },
  { id: 'qwen-audio-3.1-tts-flash-farol_pt', label: 'Farol · português, masculina' },
  { id: 'longanhuan_v3.1', label: 'Longanhuan · multilíngue (inclui português), feminina' },
  { id: 'longanlingxin_v3.1', label: 'Longanlingxin · multilíngue (inclui português), feminina' },
  { id: 'longanfengyue_v3.1', label: 'Longanfengyue · multilíngue (inclui português), feminina' },
  { id: 'xunanchuan_v3.1', label: 'Xunanchuan · multilíngue (inclui português)' },
]

const OPENAI_VOICES: ISpeechVoice[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((id) => ({
  id,
  label: `${id} · multilíngue (lê português)`,
}))

export const KNOWN_SPEECH_MODELS: Record<TSpeechEngine, ISpeechModel[]> = {
  dashscope: [
    {
      id: 'qwen-audio-3.1-tts-flash',
      label: 'qwen-audio-3.1-tts-flash · fala português (cobrado à parte do Token Plan)',
      voices: QWEN_31_FLASH,
    },
    {
      id: 'qwen-audio-3.0-tts-plus',
      label: 'qwen-audio-3.0-tts-plus · Token Plan, só chinês e inglês',
      voices: [
        { id: 'longanlingxin', label: 'Longanlingxin · chinês e inglês, feminina' },
        { id: 'longanlufeng', label: 'Longanlufeng · chinês e inglês, masculina' },
      ],
    },
  ],
  openai: [
    { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts · fala português', voices: OPENAI_VOICES },
    { id: 'tts-1', label: 'tts-1', voices: OPENAI_VOICES.filter((voice) => !['ballad', 'verse'].includes(voice.id)) },
    { id: 'tts-1-hd', label: 'tts-1-hd', voices: OPENAI_VOICES.filter((voice) => !['ballad', 'verse'].includes(voice.id)) },
  ],
}

/** O modelo do catálogo que parece de voz. */
export const looksLikeSpeech = (modelId: string) => /tts|audio|speech/i.test(modelId)

/** Os modelos a oferecer: os conhecidos do motor e os do catálogo do provider que parecem de voz (sem repetir). */
export function speechModelsFor(engine: TSpeechEngine, catalog: readonly string[]): ISpeechModel[] {
  const known = KNOWN_SPEECH_MODELS[engine]
  const extra = catalog.filter((id) => looksLikeSpeech(id) && !known.some((model) => model.id === id)).map((id) => ({ id, label: id, voices: [] }))
  return [...known, ...extra]
}
