import { ZodType } from 'zod'
import { HttpError } from './Http.Error'

/**
 * Valida o corpo da requisição antes que ele chegue ao domínio.
 *
 * Sem isto, `message` ausente virava `String(undefined)` e chegava ao provider como a
 * palavra "undefined" — um turno inteiro gasto por causa de um campo faltando.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data

  const details = parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }))

  throw new HttpError(422, 'validation_error', 'Request body is invalid', details)
}

/** O `replyTo` do corpo de uma resposta: vazio = nenhum; o que não é texto é 422. */
export function replyToOf(body: unknown): string | undefined {
  const raw = (body as { replyTo?: unknown } | undefined)?.replyTo
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new HttpError(422, 'validation_error', 'replyTo must be a message id', [{ field: 'replyTo', message: 'must be a message id' }])
  }
  return typeof raw === 'string' && raw ? raw : undefined
}
