import { EProvider } from '@domain/enums/EProvider.Enum'
import { ENV_KEY_NAME, ICredentialSource } from '@domain/ports/CredentialStore.Port'

const LABEL: Record<EProvider, string> = { [EProvider.CLAUDE]: 'Claude', [EProvider.OPENAI]: 'OpenAI', [EProvider.GOOGLE]: 'Gemini' }

/** Sem chave nenhuma (nem salva, nem no `.env`): a mensagem diz onde resolver, não "401 do fornecedor". */
export class MissingCredentialError extends Error {
  constructor(readonly provider: EProvider) {
    super(`Nenhuma chave de API configurada para ${LABEL[provider]}. Configure em Providers.`)
    this.name = 'MissingCredentialError'
  }
}

/** A chave em vigor: a da store, senão a do ambiente. Lança sem nenhuma das duas. */
export function requireKey(provider: EProvider, source?: ICredentialSource): string {
  const key = source ? source.get(provider) : process.env[ENV_KEY_NAME[provider]]?.trim() || undefined
  if (!key) throw new MissingCredentialError(provider)
  return key
}

/**
 * O cliente do SDK de um provider, refeito quando a chave muda.
 *
 * ⚖️ PEDIDO NA HORA DA CHAMADA, e guardado enquanto a chave for a mesma: o cliente segura conexões
 * abertas, e recriá-lo a cada turno as jogaria fora. Trocar a chave pela tela troca o cliente na
 * próxima chamada. `fixed` é o cliente injetado pelo teste — esse nunca é trocado.
 */
export class KeyedClient<TClient> {
  private cached?: { key: string; client: TClient }

  constructor(
    private readonly provider: EProvider,
    private readonly make: (key: string) => TClient,
    private readonly source?: ICredentialSource,
    private readonly fixed?: TClient,
  ) {}

  get(): TClient {
    if (this.fixed) return this.fixed

    const key = requireKey(this.provider, this.source)
    if (this.cached?.key !== key) this.cached = { key, client: this.make(key) }
    return this.cached.client
  }
}
