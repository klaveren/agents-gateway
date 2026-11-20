/** 🎙️ Uma voz da CONTA no provider (Alibaba DashScope: voz clonada ou desenhada). `model` = o modelo de voz a que ela pertence, quando a listagem diz. */
export interface IProviderVoice {
  id: string
  model?: string
}

export interface IProviderVoices {
  voices: IProviderVoice[]
  fetchedAt?: string
}

/** Onde ficam as vozes da conta de cada provider (lidas na atualização da lista de modelos). */
export interface IProviderVoiceStore {
  get(providerId: string): IProviderVoices
  set(providerId: string, voices: IProviderVoice[], at: Date): void
  clear(providerId: string): void
}

/** As vozes que servem ao modelo: as dele e as sem modelo conhecido. */
export function voicesForModel(voices: readonly IProviderVoice[], model: string | undefined): IProviderVoice[] {
  return voices.filter((voice) => !model || !voice.model || voice.model === model)
}
