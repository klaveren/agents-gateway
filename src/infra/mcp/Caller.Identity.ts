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
