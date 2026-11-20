import { createHash } from 'node:crypto'
import type { IProviderConnection } from '@domain/models/Provider.Model'
import type { IAgentSettings } from '@domain/models/Settings.Model'
import { DEFAULT_VOICE_PREFERENCES, IVoicePreferences, normalizeVoicePreferences, SPEECH_MAX_CHARS, SPEECH_SAMPLE_TEXT } from '@domain/models/Speech.Model'
import { IProviderVoice, voicesForModel } from '@domain/models/ProviderVoice.Model'
import type { IUserPreferenceRepository } from '@domain/ports/UserPreferenceRepository.Port'

/** A voz não está configurada (sem motor nas Configurações). */
export class SpeechUnavailableError extends Error {}
/** O motor falhou (a mensagem já vem sem a chave). */
export class SpeechFailedError extends Error {}

export interface ISpeechAudio {
  data: Buffer
  mime: string
}

export interface ISpeechEngine {
  connection: Pick<IProviderConnection, 'protocol' | 'baseUrl' | 'key'> & { providerId?: string }
  model: string
  /** A voz padrão do admin. */
  voice?: string
}

export interface ISpeechDeps {
  prefs: IUserPreferenceRepository
  /** O motor de agora (as Configurações lidas a cada chamada); ausente = sem voz. */
  engine(): Promise<ISpeechEngine | undefined>
  synthesize(connection: ISpeechEngine['connection'], model: string, text: string, options: { voice?: string; rate: number; language?: string }): Promise<ISpeechAudio>
  /** 🎙️ As vozes da conta do provider do motor (DashScope); ausente = nenhuma. */
  accountVoices?(providerId: string): IProviderVoice[]
  now?: () => Date
}

export interface IVoiceView extends IVoicePreferences {
  /** `model`: o modelo de voz do admin (a tela lista as vozes dele). */
  engine: { available: boolean; model?: string; defaultVoice?: string; voices?: string[] }
}

/** Uma alteração parcial: `voice: null` volta à voz padrão. */
export interface IVoicePatch {
  enabled?: boolean
  voice?: string | null
  rate?: number
  minLevel?: IVoicePreferences['minLevel']
}

const PREFERENCE_KEY = 'voice'
const CACHE_ENTRIES = 50
const CACHE_BYTES = 40 * 1024 * 1024

/** Lê o que o admin configurou (`speechProvider`/`speechModel`/`speechVoice`) e o provider de agora; texto para `engine()`. */
export function speechEngineOf(settings: IAgentSettings | undefined, connection: (providerId: string) => ISpeechEngine['connection'] | undefined): ISpeechEngine | undefined {
  if (!settings?.speechProvider || !settings.speechModel) return undefined
  const found = connection(settings.speechProvider)
  if (!found?.key) return undefined
  return { connection: found, model: settings.speechModel, ...(settings.speechVoice ? { voice: settings.speechVoice } : {}) }
}

/**
 * 🔊 A VOZ DAS MENSAGENS (ver `Speech.Model`): as preferências de cada pessoa e a fala de um texto com o motor do admin.
 * ⚖️ Cache em memória (LRU, 50 áudios e 40 MB): a mesma mensagem, com a mesma voz e velocidade, não paga duas vezes.
 * ⛔ A chave nunca sai daqui: o erro do motor chega limpo.
 */
export class SpeechService {
  private readonly cache = new Map<string, ISpeechAudio>()
  private cached = 0

  constructor(private readonly deps: ISpeechDeps) {}

  async view(userId: string): Promise<IVoiceView> {
    const engine = await this.deps.engine().catch(() => undefined)
    const account = engine?.connection.providerId ? voicesForModel(this.deps.accountVoices?.(engine.connection.providerId) ?? [], engine.model) : []
    return {
      ...this.preferences(userId),
      engine: {
        available: !!engine,
        ...(engine ? { model: engine.model } : {}),
        ...(engine?.voice ? { defaultVoice: engine.voice } : {}),
        ...(account.length ? { voices: account.map((voice) => voice.id) } : {}),
      },
    }
  }

  preferences(userId: string): IVoicePreferences {
    const stored = this.deps.prefs.get(userId, PREFERENCE_KEY)
    if (!stored) return { ...DEFAULT_VOICE_PREFERENCES }
    try {
      return normalizeVoicePreferences(JSON.parse(stored))
    } catch {
      return { ...DEFAULT_VOICE_PREFERENCES }
    }
  }

  async save(userId: string, patch: IVoicePatch): Promise<IVoiceView> {
    const current = this.preferences(userId)
    const next = normalizeVoicePreferences({
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.rate !== undefined ? { rate: patch.rate } : {}),
      ...(patch.minLevel !== undefined ? { minLevel: patch.minLevel } : {}),
      ...(patch.voice !== undefined ? { voice: patch.voice ?? undefined } : {}),
    })
    this.deps.prefs.set(userId, PREFERENCE_KEY, JSON.stringify(next), (this.deps.now ?? (() => new Date()))())
    return this.view(userId)
  }

  /** O áudio de um texto, com a voz e a velocidade da pessoa. */
  async speak(userId: string, text: string): Promise<ISpeechAudio> {
    const engine = await this.deps.engine().catch(() => undefined)
    if (!engine) throw new SpeechUnavailableError('the voice has not been configured by the administrator')
    const prefs = this.preferences(userId)
    const voice = prefs.voice ?? engine.voice
    const spoken = text.slice(0, SPEECH_MAX_CHARS + 100)
    const key = createHash('sha256')
      .update([engine.connection.providerId ?? '', engine.model, voice ?? '', String(prefs.rate), spoken].join('|'))
      .digest('hex')
    const hit = this.cache.get(key)
    if (hit) {
      // LRU: o acesso volta a entrada para o fim.
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    let audio: ISpeechAudio
    try {
      audio = await this.deps.synthesize(engine.connection, engine.model, spoken, { ...(voice ? { voice } : {}), rate: prefs.rate })
    } catch (error: unknown) {
      throw new SpeechFailedError(failureMessage(error, engine.connection.key))
    }
    this.remember(key, audio)
    return audio
  }

  /** A frase fixa do "Testar" do Perfil. */
  sample(userId: string): Promise<ISpeechAudio> {
    return this.speak(userId, SPEECH_SAMPLE_TEXT)
  }

  private remember(key: string, audio: ISpeechAudio): void {
    if (audio.data.length > CACHE_BYTES) return
    this.cache.set(key, audio)
    this.cached += audio.data.length
    for (const [oldest, value] of this.cache) {
      if (this.cache.size <= CACHE_ENTRIES && this.cached <= CACHE_BYTES) break
      if (oldest === key) continue
      this.cache.delete(oldest)
      this.cached -= value.data.length
    }
  }
}

/** A mensagem do erro sem a chave, curta. */
function failureMessage(error: unknown, key: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error)
  return (key ? message.split(key).join('***') : message).slice(0, 300)
}
