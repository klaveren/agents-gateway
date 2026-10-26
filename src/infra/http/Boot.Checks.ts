import { trustProxyIssue } from './Security.Middleware'
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']
const AUTH_SECRET_MIN = 32

/**
 * ⛔ O que impede o gateway de SUBIR: combinações de configuração que o deixariam aberto sem que ninguém
 * percebesse. Melhor não subir do que subir assim.
 */
export function bootIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  const issues: string[] = []
  const host = env.HOST?.trim() || '127.0.0.1'

  // Anônimo é "quem alcança a porta conversa com os seus agentes, na sua conta". Fora do loopback, é a internet.
  if (env.ALLOW_ANONYMOUS?.trim() === '1' && !LOOPBACK_HOSTS.includes(host)) {
    issues.push(`ALLOW_ANONYMOUS=1 with HOST=${host}: anonymous access only on loopback (127.0.0.1). Remove one of them.`)
  }
  // Segredo curto deixa forjar token de admin offline (HS256).
  const secret = env.AUTH_SECRET?.trim()
  if (secret && secret.length < AUTH_SECRET_MIN) issues.push(`AUTH_SECRET has ${secret.length} characters: use at least ${AUTH_SECRET_MIN} (or leave it unset to generate one).`)

  const proxy = trustProxyIssue(env.TRUST_PROXY)
  if (proxy) issues.push(proxy)

  return issues
}

/** O que não impede de subir, mas precisa ser dito: configuração que parece proteger e não protege mais. */
export function bootWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = []
  // ⚠️ O portão do serviço saiu: quem ainda o define acharia que está protegido por ele. A proteção é o login.
  if (env.GATEWAY_TOKEN?.trim()) warnings.push('GATEWAY_TOKEN no longer has any effect: access is protected by the login (accounts and access tokens). Remove it.')
  return warnings
}
