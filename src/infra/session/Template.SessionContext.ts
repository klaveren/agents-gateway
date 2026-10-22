import { ISessionContextProvider, ISessionIdentity } from '@domain/ports/SessionContextProvider.Port'

const PLACEHOLDER = /\{(id|email|role|account|date)\}/g
const MAX_VALUE_CHARS = 200

/**
 * Valor de identidade seguro para entrar numa instrução.
 *
 * ⛔ O e-mail e a conta vêm do token, e o contexto é lido pelo modelo como mensagem do sistema. Uma
 * quebra de linha num desses campos abriria um parágrafo novo com texto escolhido por quem montou o
 * token — instrução disfarçada de contexto. Controles viram espaço, e o tamanho é limitado.
 */
function clean(value: string): string {
  // Controles (`\n`, `\t`…) e separadores de linha/parágrafo Unicode.
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .slice(0, MAX_VALUE_CHARS)
}

/** A data de hoje no fuso pedido (`AAAA-MM-DD`). Fuso inválido cai em UTC, avisando uma vez. */
let warnedTimezone = false
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

  try {
    return format(timeZone)
  } catch {
    if (!warnedTimezone) {
      warnedTimezone = true
      console.warn(`[config] SESSION_TIMEZONE inválido ("${timeZone}"); usando UTC.`)
    }

    return format('UTC')
  }
}

/**
 * O contexto a partir de um modelo de texto: `{id}`, `{email}`, `{role}`, `{account}` e `{date}`.
 *
 * ⚖️ SE O MODELO CITA UM CAMPO DE IDENTIDADE QUE O TOKEN NÃO TRAZ, NÃO HÁ CONTEXTO. Renderizar
 * `conta ""` ensinaria ao modelo uma conta vazia como se fosse fato; é mais honesto não dizer nada.
 * `{date}` nunca falta. Placeholder que não é um destes fica como está — o erro de digitação aparece
 * no texto em vez de sumir.
 */
export function templateContext(template: string, timeZone = 'UTC', now: () => Date = () => new Date()): ISessionContextProvider {
  return (identity: ISessionIdentity) => {
    let missing = false

    const text = template.replace(PLACEHOLDER, (_match, key: keyof ISessionIdentity | 'date') => {
      if (key === 'date') return todayIn(timeZone, now())

      const value = identity[key]
      if (!value) {
        missing = true
        return ''
      }

      return clean(value)
    })

    return missing || !text.trim() ? undefined : text
  }
}

/**
 * O provider padrão, vindo do ambiente: `SESSION_CONTEXT_TEMPLATE` e `SESSION_TIMEZONE` (default
 * `UTC`). Sem modelo, `undefined` — nenhum contexto, e a mensagem segue exatamente como chegou.
 */
export function sessionContextFromEnv(env: NodeJS.ProcessEnv = process.env): ISessionContextProvider | undefined {
  const template = env.SESSION_CONTEXT_TEMPLATE?.trim()
  if (!template) return undefined

  return templateContext(template, env.SESSION_TIMEZONE?.trim() || 'UTC')
}
