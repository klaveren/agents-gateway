import { InvalidProviderError, ProviderInUseError, ProviderNotFoundError } from '@domain/errors/Domain.Error'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConfig, IProviderConnection } from '@domain/models/Provider.Model'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { IProviderDirectory, IProviderRepository } from '@domain/ports/ProviderRepository.Port'
import { normalizeBaseUrl, providerIssues } from '@domain/Provider.Policy'

export interface INewProvider {
  id: string
  name: string
  protocol: EProvider
  baseUrl: string
}

/**
 * Os providers: os três oficiais e os compatíveis (OpenRouter, vLLM, LiteLLM…), e a conexão de cada
 * um — protocolo, URL e a chave em vigor.
 *
 * ⛔ OFICIAL NÃO SE APAGA e não muda de URL: o SDK sabe onde ele mora, e uma URL trocada mandaria a
 * chave da Anthropic para outro lugar. Dá para desligar e renomear.
 */
export class ProvidersService implements IProviderDirectory {
  constructor(
    private readonly providers: IProviderRepository,
    private readonly credentials: ICredentialStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): IProviderConfig[] {
    return this.providers.list()
  }

  get(id: string): IProviderConfig | undefined {
    return this.providers.get(id)
  }

  connection(id: string): IProviderConnection | undefined {
    const provider = this.providers.get(id)
    if (!provider?.enabled) return undefined

    return { providerId: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, key: this.credentials.get(provider.id) }
  }

  create(input: INewProvider, by: string): IProviderConfig {
    const issues = providerIssues(
      input,
      this.providers.list().map((provider) => provider.id),
    )
    if (issues.length) throw new InvalidProviderError(issues)

    const now = this.now()
    const provider: IProviderConfig = {
      id: input.id,
      name: input.name.trim(),
      protocol: input.protocol,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      official: false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }
    this.providers.insert(provider)
    return provider
  }

  update(id: string, change: { name?: string; baseUrl?: string; enabled?: boolean }, by: string): IProviderConfig {
    const current = this.providers.get(id)
    if (!current) throw new ProviderNotFoundError(id)
    if (current.official && change.baseUrl !== undefined) throw new InvalidProviderError([{ field: 'baseUrl', message: 'official providers have a fixed URL' }])

    const issues = providerIssues({ name: change.name ?? current.name, baseUrl: change.baseUrl }, [])
    if (issues.length) throw new InvalidProviderError(issues)

    return this.providers.update(id, {
      name: change.name?.trim(),
      baseUrl: change.baseUrl === undefined ? undefined : normalizeBaseUrl(change.baseUrl),
      enabled: change.enabled,
      updatedAt: this.now(),
      updatedBy: by,
    }) as IProviderConfig
  }

  /**
   * Apaga um compatível, e a chave dele junto. ⛔ Recusa enquanto algum agente o usa: o agente ficaria
   * apontando para o nada, e a primeira conversa descobriria isso.
   */
  remove(id: string, usedBy: (providerId: string) => string[]): void {
    const current = this.providers.get(id)
    if (!current) throw new ProviderNotFoundError(id)
    if (current.official) throw new InvalidProviderError([{ field: 'id', message: 'official providers cannot be deleted — disable it instead' }])

    const agents = usedBy(id)
    if (agents.length) throw new ProviderInUseError(id, agents)

    this.providers.delete(id)
    this.credentials.clear(id)
  }
}
