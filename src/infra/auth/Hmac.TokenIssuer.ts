import { createHmac, timingSafeEqual } from 'node:crypto'
import { USER_ROLES, TUserRole } from '@domain/models/User.Model'
import { ISessionClaims, ITokenIssuer } from '@domain/ports/TokenIssuer.Port'

export const LOCAL_ISSUER = 'agents-gateway'
const DEFAULT_TTL_HOURS = 12

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

function decode(part: string | undefined): Record<string, unknown> | undefined {
  try {
    return part ? (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * JWT HS256 escrito à mão — são vinte linhas, e uma biblioteca de JWT traz junto os algoritmos que
 * ninguém aqui quer aceitar.
 *
 * ⛔ O CABEÇALHO NÃO ESCOLHE O ALGORITMO. É HS256 e só: o ataque clássico é mandar `alg: none` e ver
 * se o verificador obedece. ⚖️ No formato de JWT porque o gateway já lê a identidade do payload
 * (`identityFromToken`): `sub`, `email` e `role` chegam lá sem nada novo.
 */
export class HmacTokenIssuer implements ITokenIssuer {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = ttlFromEnv(),
    private readonly now: () => number = Date.now,
  ) {}

  issue(claims: ISessionClaims): { token: string; expiresAt: Date } {
    const iat = Math.floor(this.now() / 1000)
    const exp = iat + Math.floor(this.ttlMs / 1000)
    const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: LOCAL_ISSUER, sub: claims.sub, email: claims.email, role: claims.role, iat, exp })}`

    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(exp * 1000) }
  }

  verify(token: string): (ISessionClaims & { exp: number }) | undefined {
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature) return undefined
    if (decode(header)?.alg !== 'HS256') return undefined

    const expected = Buffer.from(this.sign(`${header}.${payload}`))
    const actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined

    const claims = decode(payload)
    if (!claims || claims.iss !== LOCAL_ISSUER) return undefined
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) return undefined
    if (typeof claims.sub !== 'string' || typeof claims.email !== 'string' || !USER_ROLES.includes(claims.role as TUserRole)) return undefined

    return { sub: claims.sub, email: claims.email, role: claims.role as TUserRole, exp: claims.exp }
  }

  owns(token: string): boolean {
    return decode(token.split('.')[1])?.iss === LOCAL_ISSUER
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}

function ttlFromEnv(): number {
  const hours = Number(process.env.AUTH_TOKEN_TTL_HOURS)
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3_600_000
}
