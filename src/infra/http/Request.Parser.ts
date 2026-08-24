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
