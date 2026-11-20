import { EProvider } from '@domain/enums/EProvider.Enum'
import type { IProviderConnection } from '@domain/models/Provider.Model'
import { isAlwaysBlockedHost, isCloudMetadataHost } from '@domain/Url.Policy'

/**
 * 🔊 TRANSFORMA TEXTO EM FALA pelo provider configurado (Configurações → Voz): a API nativa de síntese da Alibaba (DashScope,
 * quando o provider é da `aliyuncs.com` ou da `qwencloudapi.com`) ou o `audio/speech` da OpenAI (e dos compatíveis). Devolve
 * os bytes (mp3) e o tipo.
 * ⛔ A chave só vai no cabeçalho da chamada ao provider (nunca na URL, no download do áudio nem no erro).
 */
export interface ISynthesizedSpeech {
  data: Buffer
  mime: string
}

export interface ISpeechOptions {
  /** A voz; ausente = a `alloy` na OpenAI, e erro na DashScope (cada modelo tem as suas). */
  voice?: string
  /** A velocidade (0,5 a 2). */
  rate: number
  language?: string
}

const TIMEOUT_MS = 60_000
/** O teto do áudio baixado: uma mensagem falada não passa disto. */
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024

export async function synthesizeSpeech(
  connection: Pick<IProviderConnection, 'protocol' | 'baseUrl' | 'key'>,
  model: string,
  text: string,
  options: ISpeechOptions,
  fetcher: typeof fetch = fetch,
): Promise<ISynthesizedSpeech> {
  if (!connection.key) throw new Error('the voice provider has no API key')
  if (connection.protocol !== EProvider.OPENAI) throw new Error(`${connection.protocol} does not speak here (use an OpenAI-protocol provider)`)
  const language = options.language ?? 'pt'
  const origin = dashscopeOrigin(connection.baseUrl)
  if (origin) {
    if (!options.voice) throw new Error('this provider has no default voice: the administrator must set the default voice in Settings → Voz')
    return dashscope(origin, connection.key, model, text, options.voice, options.rate, language, fetcher)
  }
  return openai(connection.baseUrl ?? 'https://api.openai.com/v1', connection.key, model, text, options.voice || 'alloy', options.rate, fetcher)
}

/** A origem do provider se ele é da Alibaba (DashScope); senão, ausente. */
function dashscopeOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.toLowerCase()
    return host.endsWith('.aliyuncs.com') || host.endsWith('.qwencloudapi.com') ? url.origin : undefined
  } catch {
    return undefined
  }
}

async function openai(base: string, key: string, model: string, text: string, voice: string, rate: number, fetcher: typeof fetch): Promise<ISynthesizedSpeech> {
  const response = await fetcher(`${base.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice, response_format: 'mp3', speed: rate }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    throw new Error(clean(body?.error?.message ?? `HTTP ${response.status}`, key))
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (!data.length) throw new Error('the provider answered without audio')
  return { data, mime: response.headers.get('content-type')?.split(';')[0].trim() || 'audio/mpeg' }
}

type TDashscope = { output?: { audio?: { url?: string; data?: string } }; code?: string; message?: string }

async function dashscope(
  origin: string,
  key: string,
  model: string,
  text: string,
  voice: string,
  rate: number,
  language: string,
  fetcher: typeof fetch,
): Promise<ISynthesizedSpeech> {
  const response = await fetcher(`${origin}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: { text, voice, format: 'mp3', rate, language_hints: [language] } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  })
  const body = (await response.json().catch(() => undefined)) as TDashscope | undefined
  if (!response.ok || body?.code) throw new Error(clean(body?.message ?? body?.code ?? `HTTP ${response.status}`, key))
  const audio = body?.output?.audio
  if (audio?.data) {
    const data = Buffer.from(audio.data, 'base64')
    if (data.length) return { data, mime: 'audio/mpeg' }
  }
  if (!audio?.url) throw new Error('the provider answered without audio')
  return download(audio.url, key, fetcher)
}

/** O áudio que a DashScope hospeda: só https, nunca um endereço interno, sem a chave, com teto de tamanho. */
async function download(raw: string, key: string, fetcher: typeof fetch): Promise<ISynthesizedSpeech> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('the provider returned an invalid audio address')
  }
  if (url.protocol !== 'https:' || isAlwaysBlockedHost(url.hostname) || isCloudMetadataHost(url.hostname))
    throw new Error('the provider returned an audio address that is not allowed')
  const response = await fetcher(url.toString(), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  if (!response.ok) throw new Error(clean(`could not download the audio (HTTP ${response.status})`, key))
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_AUDIO_BYTES) throw new Error('the audio is too large')
  const data = Buffer.from(await response.arrayBuffer())
  if (!data.length) throw new Error('the provider answered without audio')
  if (data.length > MAX_AUDIO_BYTES) throw new Error('the audio is too large')
  return { data, mime: response.headers.get('content-type')?.split(';')[0].trim() || 'audio/mpeg' }
}

/** A mensagem do provider sem a chave (alguns a repetem no erro). */
function clean(message: string, key: string): string {
  return message.split(key).join('***').slice(0, 400)
}
