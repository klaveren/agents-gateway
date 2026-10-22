import { EProvider } from '@domain/enums/EProvider.Enum'

export interface IProbeResult {
  ok: boolean
  /** Respondeu, mas sem provar a chave (a listagem do provider é pública). */
  unverified?: boolean
  /** Quantos modelos a chave enxerga — a prova de que ela autentica. */
  models?: number
  status?: number
  message?: string
}

const TIMEOUT_MS = 8_000

/**
 * A chamada MAIS BARATA de cada provider que exige a chave: listar modelos. Não gasta token, e um
 * 401/403 aqui é exatamente a resposta que a primeira conversa daria.
 *
 * ⚖️ A chave vai em CABEÇALHO nos três (o Gemini aceita `x-goog-api-key`): na URL ela acabaria em log
 * de proxy.
 */
const OFFICIAL_BASE: Record<EProvider, string> = {
  [EProvider.CLAUDE]: 'https://api.anthropic.com',
  [EProvider.OPENAI]: 'https://api.openai.com/v1',
  [EProvider.GOOGLE]: 'https://generativelanguage.googleapis.com/v1beta',
}

/**
 * A listagem de modelos de cada PROTOCOLO, na URL do provider (a oficial, ou a do compatível).
 *
 * ⚖️ O caminho segue o que cada SDK monta sobre a `baseURL`: o da Anthropic acrescenta `/v1/…` (a URL de
 * um compatível Anthropic vem SEM o `/v1`), o da OpenAI acrescenta só `/…` (a de um compatível OpenAI vem COM).
 */
function requestFor(protocol: EProvider, key: string, baseUrl?: string): { url: string; headers: Record<string, string> } {
  const base = baseUrl ?? OFFICIAL_BASE[protocol]
  if (protocol === EProvider.CLAUDE) return { url: `${base}/v1/models?limit=100`, headers: { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } }
  if (protocol === EProvider.OPENAI) return { url: `${base}/models`, headers: { Authorization: `Bearer ${key}` } }
  return { url: `${base}/models?pageSize=100`, headers: { 'x-goog-api-key': key } }
}

/** ⛔ A chave nunca volta numa mensagem de erro: qualquer eco dela (o fornecedor às vezes ecoa) vira `…1234`. */
export function maskKey(text: string, key: string): string {
  return key ? text.split(key).join(`…${key.slice(-4)}`) : text
}

export async function probeKey(connection: { protocol: EProvider; baseUrl?: string }, key: string, fetcher: typeof fetch = fetch): Promise<IProbeResult> {
  const { url, headers } = requestFor(connection.protocol, key, connection.baseUrl)

  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = (await response.json().catch(() => undefined)) as { data?: unknown[]; models?: unknown[]; error?: { message?: string } } | undefined

    if (!response.ok) return { ok: false, status: response.status, message: maskKey(body?.error?.message ?? `HTTP ${response.status}`, key) }

    const models = (body?.data ?? body?.models ?? []).length

    // ⚠️ Há provider compatível em que a listagem de modelos é PÚBLICA: responde 200 com qualquer chave.
    // Pedir de novo SEM chave separa os dois casos — se também responde, a listagem não prova nada, e a
    // tela diz isso em vez de "a chave funciona" para uma chave inventada.
    if (connection.baseUrl && (await answersWithoutKey(url, fetcher))) {
      return { ok: true, models, unverified: true, message: 'A listagem de modelos deste provider é pública: a chave só se confirma na primeira conversa.' }
    }

    return { ok: true, models }
  } catch (error: unknown) {
    const message = error instanceof Error && error.name === 'TimeoutError' ? 'o fornecedor não respondeu a tempo' : error instanceof Error ? error.message : String(error)
    return { ok: false, message: maskKey(message, key) }
  }
}

/** A mesma URL, sem credencial nenhuma: responde 200? */
async function answersWithoutKey(url: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    return (await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).ok
  } catch {
    return false
  }
}
