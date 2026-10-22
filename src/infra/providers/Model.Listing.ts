import { EProvider } from '@domain/enums/EProvider.Enum'
import { IListedModel } from '@domain/models/ModelCatalog.Model'
import { IModelPrice } from '@domain/models/Model.Pricing'
import { maskKey } from './Provider.Probe'

const TIMEOUT_MS = 15_000
const MAX_PAGES = 20

const OFFICIAL_BASE: Record<EProvider, string> = {
  [EProvider.CLAUDE]: 'https://api.anthropic.com',
  [EProvider.OPENAI]: 'https://api.openai.com/v1',
  [EProvider.GOOGLE]: 'https://generativelanguage.googleapis.com/v1beta',
}

/**
 * O que a OpenAI OFICIAL lista e não conversa: embeddings, voz, imagem, moderação. Ficam de fora para a
 * lista não começar com 80 itens que nenhum agente usaria. Só no oficial — um compatível lista o que é dele.
 */
const OPENAI_NOT_CHAT = /(embedding|whisper|tts|dall-e|moderation|transcribe|image|audio|realtime|search|davinci|babbage)/i

type TPage = { items: IListedModel[]; next?: string }

/**
 * Lista os modelos de um provider, no formato de cada protocolo, com paginação.
 *
 * ⚖️ PREÇO SÓ QUANDO A LISTAGEM TRAZ: os oficiais não trazem (a tabela de fábrica sugere); há agregadores
 * que trazem por token (`pricing.prompt`/`pricing.completion`) — e aí vira preço por 1M aqui.
 *
 * ⛔ Lança com a chave mascarada.
 */
export async function listModels(connection: { protocol: EProvider; baseUrl?: string }, key: string, fetcher: typeof fetch = fetch): Promise<IListedModel[]> {
  const base = connection.baseUrl ?? OFFICIAL_BASE[connection.protocol]
  const all: IListedModel[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { items, next } = await fetchPage(connection.protocol, base, key, cursor, fetcher)
    all.push(...items)
    if (!next) break
    cursor = next
  }

  const official = !connection.baseUrl
  return connection.protocol === EProvider.OPENAI && official ? all.filter((model) => !OPENAI_NOT_CHAT.test(model.id)) : all
}

async function fetchPage(protocol: EProvider, base: string, key: string, cursor: string | undefined, fetcher: typeof fetch): Promise<TPage> {
  const { url, headers } = request(protocol, base, key, cursor)
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined

  if (!response.ok) {
    const message = ((body?.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`) as string
    throw new Error(maskKey(`A listagem de modelos falhou: ${message}`, key))
  }

  if (protocol === EProvider.GOOGLE) {
    const models = (body?.models as Array<Record<string, unknown>> | undefined) ?? []
    return {
      items: models
        .filter((model) => (model.supportedGenerationMethods as string[] | undefined)?.includes('generateContent') ?? true)
        .map((model) => ({ id: String(model.name).replace(/^models\//, ''), label: text(model.displayName), contextLength: number(model.inputTokenLimit) })),
      next: text(body?.nextPageToken),
    }
  }

  const data = (body?.data as Array<Record<string, unknown>> | undefined) ?? []
  const items = data.map((model) => ({
    id: String(model.id),
    label: text(model.display_name) ?? text(model.name),
    contextLength: number(model.context_length),
    price: priceOf(model.pricing),
  }))

  if (protocol === EProvider.CLAUDE) return { items, next: body?.has_more === true ? text(body?.last_id) : undefined }
  return { items }
}

function request(protocol: EProvider, base: string, key: string, cursor?: string): { url: string; headers: Record<string, string> } {
  if (protocol === EProvider.CLAUDE) {
    return {
      url: `${base}/v1/models?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`,
      headers: { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    }
  }
  if (protocol === EProvider.OPENAI) return { url: `${base}/models`, headers: { Authorization: `Bearer ${key}` } }
  return { url: `${base}/models?pageSize=1000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`, headers: { 'x-goog-api-key': key } }
}

/**
 * O preço da listagem, quando há: por TOKEN (texto) → por 1M (número). Campo que não é número válido
 * é ignorado; sem entrada E saída, não há preço (melhor "sem preço" do que um preço pela metade).
 */
export function priceOf(raw: unknown): IModelPrice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const pricing = raw as Record<string, unknown>
  const perMillion = (value: unknown) => {
    const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1_000_000 * 1e6) / 1e6 : undefined
  }

  const input = perMillion(pricing.prompt)
  const output = perMillion(pricing.completion)
  if (input === undefined || output === undefined) return undefined

  const cacheRead = perMillion(pricing.input_cache_read)
  const cacheWrite = perMillion(pricing.input_cache_write)
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
