import { EProvider } from '@domain/enums/EProvider.Enum'
import { ENV_KEY_NAME } from '@domain/ports/CredentialStore.Port'
import { IProviderConnection } from '@domain/models/Provider.Model'

/** O que os adapters pedem: como chamar ESTE provider agora (protocolo, URL, chave). */
export interface IConnectionSource {
  connection(providerId: string): IProviderConnection | undefined
}

/** Sem chave nenhuma (nem salva, nem no `.env`): a mensagem diz onde resolver, não "401 do fornecedor". */
export class MissingCredentialError extends Error {
  constructor(readonly providerName: string) {
    super(`Nenhuma chave de API configurada para ${providerName}. Configure em Providers.`)
    this.name = 'MissingCredentialError'
  }
}

/** O provider do agente sumiu ou foi desligado depois de a sessão nascer. */
export class UnavailableProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`O provider ${providerId} não está disponível (removido ou desligado). Verifique em Providers.`)
    this.name = 'UnavailableProviderError'
  }
}

export interface IResolvedConnection {
  key: string
  baseUrl?: string
  /** `false` para os oficiais (o SDK sabe a URL); `true` para OpenRouter, vLLM, LiteLLM… */
  compatible: boolean
}

/**
 * A conexão em vigor para um provider. Sem fonte (teste, montagem à mão), vale o ambiente do
 * protocolo — o comportamento de antes de os providers virarem dado. Lança sem chave.
 */
export function requireConnection(providerId: string, protocol: EProvider, source?: IConnectionSource): IResolvedConnection {
  if (!source) {
    const key = process.env[ENV_KEY_NAME[protocol]]?.trim()
    if (!key) throw new MissingCredentialError(providerId)
    return { key, compatible: false }
  }

  const connection = source.connection(providerId)
  if (!connection) throw new UnavailableProviderError(providerId)
  if (!connection.key) throw new MissingCredentialError(connection.name)

  return { key: connection.key, baseUrl: connection.baseUrl, compatible: !!connection.baseUrl }
}

/**
 * O cliente do SDK de um provider, refeito quando a chave ou a URL mudam.
 *
 * ⚖️ PEDIDO NA HORA DA CHAMADA, e guardado por provider enquanto a conexão for a mesma: o cliente segura
 * conexões abertas, e recriá-lo a cada turno as jogaria fora. Um adapter atende vários providers do
 * mesmo protocolo (a Anthropic oficial e um compatível), então o cache é por provider. `fixed` é o
 * cliente injetado pelo teste — esse nunca é trocado.
 */
export class KeyedClient<TClient> {
  private readonly cached = new Map<string, { signature: string; client: TClient }>()

  constructor(
    private readonly protocol: EProvider,
    private readonly make: (connection: IResolvedConnection) => TClient,
    private readonly source?: IConnectionSource,
    private readonly fixed?: TClient,
  ) {}

  get(providerId: string): TClient {
    if (this.fixed) return this.fixed

    const connection = requireConnection(providerId, this.protocol, this.source)
    const signature = `${connection.baseUrl ?? ''}\u0000${connection.key}`
    const current = this.cached.get(providerId)
    if (current?.signature === signature) return current.client

    const client = this.make(connection)
    this.cached.set(providerId, { signature, client })
    return client
  }
}
