import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { IPasswordHasher } from '@domain/ports/PasswordHasher.Port'

/**
 * scrypt do próprio Node — sem dependência nativa (bcrypt/argon2 compilam e quebram em troca de versão).
 *
 * ⚖️ OS PARÂMETROS VÃO NO HASH (`scrypt$N$r$p$salt$hash`): subir o custo amanhã não invalida as senhas
 * de hoje, cada hash diz com que custo foi feito. N=2^15 fica na casa de dezenas de milissegundos —
 * irrelevante num login, caro para quem tenta milhões.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
  constructor(private readonly cost = { N: 32768, r: 8, p: 1 }) {}

  hash(password: string): string {
    const salt = randomBytes(16)
    const { N, r, p } = this.cost
    const key = scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 })

    return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$')
  }

  verify(password: string, stored: string): boolean {
    try {
      const [scheme, N, r, p, salt, key] = stored.split('$')
      if (scheme !== 'scrypt' || !salt || !key) return false

      const expected = Buffer.from(key, 'base64url')
      const params = { N: Number(N), r: Number(r), p: Number(p) }
      const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { ...params, maxmem: 128 * params.N * params.r * 2 })

      return timingSafeEqual(actual, expected)
    } catch {
      return false
    }
  }

  /** No pool de threads do libuv: o laço de eventos segue atendendo enquanto a senha é conferida. */
  verifyAsync(password: string, stored: string): Promise<boolean> {
    const [scheme, N, r, p, salt, key] = stored.split('$')
    if (scheme !== 'scrypt' || !salt || !key) return Promise.resolve(false)
    const expected = Buffer.from(key, 'base64url')
    const params = { N: Number(N), r: Number(r), p: Number(p) }

    return new Promise((resolve) => {
      try {
        scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { ...params, maxmem: 128 * params.N * params.r * 2 }, (error, actual) =>
          resolve(!error && actual.length === expected.length && timingSafeEqual(actual, expected)),
        )
      } catch {
        resolve(false)
      }
    })
  }
}
