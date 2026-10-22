import { EProvider } from '@domain/enums/EProvider.Enum'

export interface IProbeResult {
  ok: boolean
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
const REQUESTS: Record<EProvider, (key: string) => { url: string; headers: Record<string, string> }> = {
  [EProvider.CLAUDE]: (key) => ({ url: 'https://api.anthropic.com/v1/models?limit=100', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
  [EProvider.OPENAI]: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  [EProvider.GOOGLE]: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', headers: { 'x-goog-api-key': key } }),
}

/** ⛔ A chave nunca volta numa mensagem de erro: qualquer eco dela (o fornecedor às vezes ecoa) vira `…1234`. */
export function maskKey(text: string, key: string): string {
  return key ? text.split(key).join(`…${key.slice(-4)}`) : text
}

export async function probeKey(provider: EProvider, key: string, fetcher: typeof fetch = fetch): Promise<IProbeResult> {
  const { url, headers } = REQUESTS[provider](key)

  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = (await response.json().catch(() => undefined)) as { data?: unknown[]; models?: unknown[]; error?: { message?: string } } | undefined

    if (!response.ok) return { ok: false, status: response.status, message: maskKey(body?.error?.message ?? `HTTP ${response.status}`, key) }

    return { ok: true, models: (body?.data ?? body?.models ?? []).length }
  } catch (error: unknown) {
    const message = error instanceof Error && error.name === 'TimeoutError' ? 'o fornecedor não respondeu a tempo' : error instanceof Error ? error.message : String(error)
    return { ok: false, message: maskKey(message, key) }
  }
}
