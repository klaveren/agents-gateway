import { IAudienceRules } from '@domain/models/Settings.Model'
import { requireProvenOwner } from './Caller.Access'

/**
 * Uma lista de env separada por vírgula, normalizada (minúsculas, sem vazios). Variável ausente ou
 * vazia = `fallback`. Lido a cada chamada, para o teste não depender da ordem em que roda.
 */
export function listFromEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name]?.trim()
  if (!raw) return [...fallback]

  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * As regras de audiência, vindas do ambiente.
 *
 * ⚖️ `AUDIENCE_ROLES` (padrão `admin`) é quem passa sob `restricted`; `DENIED_ROLES` (padrão vazio)
 * é recusado sob QUALQUER audiência. Os nomes dos papéis são do produto que emite o token — o
 * gateway não conhece nenhum, e o papel lido é o de `CALLER_ROLE_CLAIM`.
 */
export function audienceRules(): IAudienceRules {
  return {
    audienceRoles: listFromEnv('AUDIENCE_ROLES', ['admin']),
    deniedRoles: listFromEnv('DENIED_ROLES', []),
    requireProven: requireProvenOwner(),
  }
}
