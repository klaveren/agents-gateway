import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Quem está do outro lado desta requisição — e com que credencial.
 *
 * ⚖️ O GATEWAY NÃO TEM IDENTIDADE PRÓPRIA, e é isso que torna o desenho seguro. Ele não guarda
 * token de ninguém, não escolhe conta, não decide permissão: repassa a credencial de quem chamou
 * para o MCP, e quem autoriza é o serviço do outro lado, que já sabe fazer isso.
 *
 * ⛔ A ALTERNATIVA ERA PIOR. Com uma credencial fixa no ambiente, todo usuário opera como o dono
 * dela — mesma conta, mesmas permissões. Num gateway que atende mais de uma pessoa, isso é o dado
 * de uma visível para as outras.
 *
 * `AsyncLocalStorage` porque a credencial precisa atravessar um turno inteiro — SDK do provider,
 * loop de tools, cliente MCP — sem virar parâmetro em cada assinatura no caminho. Um parâmetro
 * esquecido em qualquer ponto significaria cair no fallback, e falha aberta não avisa ninguém.
 *
 * ⚠️ Vive só durante a requisição. O gateway NÃO persiste o token: sessão que continua depois
 * precisa da credencial de novo, o que é o certo — token guardado em memória é token que vaza num
 * dump.
 */
export type TCallerIdentity = {
  /** A credencial de quem chamou, repassada às tools. */
  token?: string
  /** Quem o token AFIRMA ser. Rótulo: sem prova (`Caller.Proof`), nunca decide acesso. */
  id?: string
  email?: string
  role?: string
  /** A conta/organização sob a qual o token afirma operar, quando o produto tem esse conceito. */
  account?: string
}

const storage = new AsyncLocalStorage<TCallerIdentity>()

export function withCaller<T>(identity: TCallerIdentity, work: () => T): T {
  return storage.run(identity, work)
}

export function caller(): TCallerIdentity | undefined {
  return storage.getStore()
}

/** Extrai o token do header, aceitando com e sem `Bearer`. */
export function tokenFromHeader(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.trim()) return undefined

  const clean = raw.replace(/^Bearer\s+/i, '').trim()

  return clean || undefined
}

/**
 * Onde, no payload do token, mora cada campo de identidade. Caminho com pontos desce em objeto
 * (`user.id`), então qualquer formato de JWT cabe sem código novo.
 *
 * ⚖️ Neutros por padrão (`sub`, `email`, `role` — os nomes do RFC 7519 e de quase todo provedor).
 * `CALLER_ACCOUNT_CLAIM` não tem padrão: nem todo produto tem conta, e inventar uma faria a
 * sessão ganhar um recorte que ninguém pediu. Lido a cada chamada, para o teste não depender da
 * ordem em que roda.
 */
export const DEFAULT_CLAIMS = { id: 'sub', email: 'email', role: 'role' } as const

function claimPath(name: string, fallback?: string): string | undefined {
  return process.env[name]?.trim() || fallback
}

/**
 * Lê um valor por caminho com pontos. Uma chave que já contém pontos (`https://x.example/role`,
 * comum em claim namespaced) vale como está, antes de descer.
 */
export function readPath(source: unknown, path: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  if (Object.prototype.hasOwnProperty.call(source, path)) return (source as Record<string, unknown>)[path]

  let current: unknown = source
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }

  return current
}

function asLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)

  return undefined
}

/**
 * Lê a identidade do payload do JWT **sem verificar a assinatura**.
 *
 * ⛔ SÓ PARA ROTULAR. O gateway não tem o segredo de quem assinou, então este valor é o que o token
 * AFIRMA — e token se forja: bastam três segmentos em base64 com o id de outra pessoa. Quem
 * autoriza é a API do outro lado, que recusa o falso, e onde a identidade decide acesso o que vale
 * é `provenCaller` (ver `Caller.Proof`), que gasta o token antes de acreditar nele.
 *
 * Token que não é JWT legível não é erro: devolve vazio, e as tools seguem — é a API que decide se
 * aquele formato vale.
 */
export function identityFromToken(token: string): Omit<TCallerIdentity, 'token'> {
  try {
    const payload = token.split('.')[1]
    if (!payload) return {}

    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const account = claimPath('CALLER_ACCOUNT_CLAIM')

    const identity: Omit<TCallerIdentity, 'token'> = {
      id: asLabel(readPath(decoded, claimPath('CALLER_ID_CLAIM', DEFAULT_CLAIMS.id)!)),
      email: asLabel(readPath(decoded, claimPath('CALLER_EMAIL_CLAIM', DEFAULT_CLAIMS.email)!)),
      role: asLabel(readPath(decoded, claimPath('CALLER_ROLE_CLAIM', DEFAULT_CLAIMS.role)!)),
      account: account ? asLabel(readPath(decoded, account)) : undefined,
    }

    // Sem chaves `undefined`: quem compara com deepStrictEqual (e quem serializa) vê só o que existe.
    return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined))
  } catch {
    return {}
  }
}
