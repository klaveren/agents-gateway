import type { IProviderVoice } from '@domain/models/ProviderVoice.Model'
import { dashscopeOrigin } from './Speech.Synthesizer'

const TIMEOUT_MS = 10_000
const PAGE_SIZE = 100
const MAX_PAGES = 5

/**
 * 🎙️ As vozes da CONTA (clonadas ou desenhadas) na Alibaba DashScope.
 * Doc: https://help.aliyun.com/en/model-studio/voice-clone-design-http-api (seção "List voices"):
 * `POST {origem}/api/v1/services/audio/tts/customization`, `Authorization: Bearer <chave>`, corpo
 * `{ model: 'voice-enrollment', input: { action: 'list_voice', page_index, page_size } }` (página começa em 0);
 * resposta `output.voice_list[] = { voice_id, target_model, status, ... }`.
 * ⚖️ TOLERANTE: qualquer erro, 404 ou formato inesperado = nenhuma voz (a atualização dos modelos não falha).
 * ⛔ A chave só vai no cabeçalho; o aviso de log não a carrega.
 * Provider que não é da DashScope: `undefined` sem chamar nada.
 */
export async function listAccountVoices(
  connection: { baseUrl?: string; key?: string },
  fetcher: typeof fetch = fetch,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<IProviderVoice[] | undefined> {
  const origin = dashscopeOrigin(connection.baseUrl)
  if (!origin || !connection.key) return undefined
  const voices: IProviderVoice[] = []
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetcher(`${origin}/api/v1/services/audio/tts/customization`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'voice-enrollment', input: { action: 'list_voice', page_index: page, page_size: PAGE_SIZE } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
      if (!response.ok) {
        warn(`[voices] a lista de vozes da conta não veio (HTTP ${response.status})`)
        return page === 0 ? [] : voices
      }
      const body = (await response.json().catch(() => undefined)) as { output?: { voice_list?: unknown } } | undefined
      const list = body?.output?.voice_list
      if (!Array.isArray(list)) {
        warn('[voices] a lista de vozes da conta veio em formato inesperado')
        return page === 0 ? [] : voices
      }
      for (const item of list as Array<{ voice_id?: unknown; target_model?: unknown; status?: unknown }>) {
        if (typeof item?.voice_id !== 'string' || !item.voice_id) continue
        if (typeof item.status === 'string' && item.status !== 'OK') continue
        voices.push({ id: item.voice_id, ...(typeof item.target_model === 'string' && item.target_model ? { model: item.target_model } : {}) })
      }
      if (list.length < PAGE_SIZE) break
    }
  } catch {
    warn('[voices] a lista de vozes da conta falhou (rede ou tempo esgotado)')
    return voices
  }
  return voices
}
