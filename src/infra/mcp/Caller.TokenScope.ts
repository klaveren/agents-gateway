import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A credencial de UMA chamada ao MCP, do `callTool` até o `fetch` do transporte.
 *
 * ⚠️ O SDK não deixa passar header por chamada — os headers são do transporte, criado na conexão.
 * Por isso a credencial precisa chegar ao `fetch` por fora.
 *
 * ⛔ NÃO PODE SER UM CAMPO DO CLIENTE. Um campo só, escrito no início de cada chamada e limpo no
 * fim, é compartilhado por todas as chamadas em voo: com duas pessoas ao mesmo tempo, a requisição
 * de A saía com o token de B — e trazia os dados da conta de B para A —, e o `finally` de uma
 * zerava a credencial da outra, que então ia sem header. O escopo assíncrono dá a cada chamada a
 * sua, sem nada para limpar.
 */
export class CallerTokenScope {
  private readonly storage = new AsyncLocalStorage<{ token?: string }>()

  /** Roda `work` com `token` como a credencial de tudo que ele disparar. */
  run<T>(token: string | undefined, work: () => Promise<T>): Promise<T> {
    return this.storage.run({ token }, work)
  }

  /**
   * `fetch` que leva a credencial do escopo atual. Sem credencial no escopo, vai sem header: o MCP
   * então cai no token do ambiente dele — é o que mantém `curl` e stdio funcionando.
   */
  wrap(base: typeof fetch = fetch, header = 'authorization'): typeof fetch {
    return (input, init) => {
      const token = this.storage.getStore()?.token
      if (!token) return base(input, init)

      const headers = new Headers(init?.headers)
      headers.set(header, `Bearer ${token}`)

      return base(input, { ...init, headers })
    }
  }
}
