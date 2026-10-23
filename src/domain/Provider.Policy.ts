import { isCloudMetadataHost } from './Url.Policy'
import { EProvider } from './enums/EProvider.Enum'

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

export interface IProviderIssue {
  field: string
  message: string
}

/**
 * O que está errado num provider compatível.
 *
 * ⚖️ SÓ OPENAI E ANTHROPIC são protocolos de compatível: são os dois que o mercado copia (agregadores,
 * vLLM, LiteLLM, Together…). O do Gemini fica só para o oficial.
 *
 * ⛔ A URL é conferida: HTTPS, ou HTTP só para esta máquina (um vLLM local); sem usuário e senha
 * embutidos (iriam para log); sem query. É para lá que vão a chave e o texto das conversas.
 */
export function providerIssues(input: { id?: string; name: string; protocol?: string; baseUrl?: string }, takenIds: readonly string[]): IProviderIssue[] {
  const issues: IProviderIssue[] = []

  if (input.id !== undefined) {
    if (!PROVIDER_ID_PATTERN.test(input.id)) issues.push({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
    else if (takenIds.includes(input.id)) issues.push({ field: 'id', message: `already exists: ${input.id}` })
  }

  if (!input.name.trim()) issues.push({ field: 'name', message: 'required' })
  else if (input.name.length > 60) issues.push({ field: 'name', message: 'at most 60 characters' })

  if (input.protocol !== undefined && input.protocol !== EProvider.OPENAI && input.protocol !== EProvider.CLAUDE) {
    issues.push({ field: 'protocol', message: 'compatible providers speak openai or claude (Anthropic)' })
  }

  if (input.baseUrl !== undefined) {
    const issue = baseUrlIssue(input.baseUrl)
    if (issue) issues.push({ field: 'baseUrl', message: issue })
  }

  return issues
}

function baseUrlIssue(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'not a valid URL'
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'use https (http only for localhost)'
  if (url.username || url.password) return 'no credentials in the URL — the key goes in its own field'
  if (url.search || url.hash) return 'no query string or fragment'
  if (isCloudMetadataHost(url.hostname)) return 'cloud metadata and link-local addresses are not allowed'
  return undefined
}

/** A URL como fica gravada: sem barra no fim, para `${baseUrl}/models` não virar `//models`. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}
