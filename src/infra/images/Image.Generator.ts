import { EProvider } from '@domain/enums/EProvider.Enum'
import { guessModelImage } from '@domain/models/ModelCatalog.Model'
import type { IProviderConnection } from '@domain/models/Provider.Model'

/**
 * 🖼️ GERA UMA IMAGEM pelo provider configurado (Configurações → Modelo de imagem): o endpoint de imagem da OpenAI (e dos
 * compatíveis que o imitam) para os "só imagem" (gpt-image, dall-e); o `chat/completions` com `modalities` para os que
 * conversam e geram imagem num compatível (os Gemini de imagem no OpenRouter); ou o `generateContent` do Gemini com
 * saída de imagem. Devolve os bytes e o tipo.
 * ⛔ A chave só vai no cabeçalho (nunca na URL nem no erro).
 */
export interface IGeneratedImage {
  data: Buffer
  mime: string
  /** Os tokens que o provider informou (cada protocolo os chama de um jeito); ausente = não informou. */
  usage?: IImageTokens
}

export interface IImageTokens {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Os tokens do provider, em qualquer dos nomes (OpenAI `input_tokens`, OpenRouter `prompt_tokens`, Gemini `promptTokenCount`). */
function tokensOf(usage: Record<string, unknown> | undefined): IImageTokens | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const count = (...names: string[]) => {
    for (const name of names) {
      const value = usage[name]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
    }
    return undefined
  }
  const inputTokens = count('input_tokens', 'prompt_tokens', 'promptTokenCount')
  const outputTokens = count('output_tokens', 'completion_tokens', 'candidatesTokenCount')
  const totalTokens = count('total_tokens', 'totalTokenCount')
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0) }
}

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const
export type TImageSize = (typeof IMAGE_SIZES)[number]

const TIMEOUT_MS = 180_000

export async function generateImage(
  connection: Pick<IProviderConnection, 'protocol' | 'baseUrl' | 'key'>,
  model: string,
  prompt: string,
  size: TImageSize = '1024x1024',
  fetcher: typeof fetch = fetch,
): Promise<IGeneratedImage> {
  if (!connection.key) throw new Error('the image provider has no API key')
  if (connection.protocol === EProvider.GOOGLE) return google(connection.key, model, prompt, fetcher)
  if (connection.protocol === EProvider.OPENAI && connection.baseUrl && !guessModelImage(model).only) return chat(connection.baseUrl, connection.key, model, prompt, fetcher)
  if (connection.protocol === EProvider.OPENAI) return openai(connection.baseUrl ?? 'https://api.openai.com/v1', connection.key, model, prompt, size, fetcher)
  throw new Error(`${connection.protocol} does not generate images here (use an OpenAI or Google provider)`)
}

async function openai(base: string, key: string, model: string, prompt: string, size: TImageSize, fetcher: typeof fetch): Promise<IGeneratedImage> {
  const response = await fetcher(`${base.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // O dall-e só devolve base64 se pedir; o gpt-image devolve sempre (e recusa o campo).
    body: JSON.stringify({ model, prompt, n: 1, size, ...(/^dall-e/i.test(model) ? { response_format: 'b64_json' } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  })
  const body = (await response.json().catch(() => undefined)) as { data?: Array<{ b64_json?: string }>; usage?: Record<string, unknown>; error?: { message?: string } } | undefined
  if (!response.ok) throw new Error(clean(body?.error?.message ?? `HTTP ${response.status}`, key))
  const encoded = body?.data?.[0]?.b64_json
  if (!encoded) throw new Error('the provider answered without an image')
  const usage = tokensOf(body?.usage)
  return { data: Buffer.from(encoded, 'base64'), mime: 'image/png', ...(usage ? { usage } : {}) }
}

/** Compatível (OpenRouter): a imagem vem em `message.images[].image_url.url`, como data URL. Só data URL: nada se baixa de fora. */
async function chat(base: string, key: string, model: string, prompt: string, fetcher: typeof fetch): Promise<IGeneratedImage> {
  const response = await fetcher(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  })
  type TImage = { image_url?: { url?: string } }
  const body = (await response.json().catch(() => undefined)) as
    { choices?: Array<{ message?: { images?: TImage[] } }>; usage?: Record<string, unknown>; error?: { message?: string } } | undefined
  if (!response.ok) throw new Error(clean(body?.error?.message ?? `HTTP ${response.status}`, key))
  const url = body?.choices?.[0]?.message?.images?.find((item) => item.image_url?.url)?.image_url?.url ?? ''
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url)
  if (!match) throw new Error('the model answered without an image (is it an image model?)')
  const usage = tokensOf(body?.usage)
  return { data: Buffer.from(match[2], 'base64'), mime: match[1], ...(usage ? { usage } : {}) }
}

async function google(key: string, model: string, prompt: string, fetcher: typeof fetch): Promise<IGeneratedImage> {
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  })
  type TPart = { inlineData?: { data?: string; mimeType?: string } }
  const body = (await response.json().catch(() => undefined)) as
    { candidates?: Array<{ content?: { parts?: TPart[] } }>; usageMetadata?: Record<string, unknown>; error?: { message?: string } } | undefined
  if (!response.ok) throw new Error(clean(body?.error?.message ?? `HTTP ${response.status}`, key))
  const part = body?.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data)
  if (!part?.inlineData?.data) throw new Error('the model answered without an image (is it an image model?)')
  const usage = tokensOf(body?.usageMetadata)
  return { data: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'image/png', ...(usage ? { usage } : {}) }
}

/** A mensagem do provider sem a chave (alguns a repetem no erro). */
function clean(message: string, key: string): string {
  return message.split(key).join('***').slice(0, 400)
}
