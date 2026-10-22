import { IProviderConfig, IProviderConnection } from '@domain/models/Provider.Model'

export type TProviderPatch = Partial<Pick<IProviderConfig, 'name' | 'baseUrl' | 'enabled' | 'updatedAt' | 'updatedBy'>>

/**
 * Onde ficam os providers. Síncrono, como o de agentes: é consultado no caminho de toda chamada.
 * ⛔ Escrever lança.
 */
export interface IProviderRepository {
  list(): IProviderConfig[]
  get(id: string): IProviderConfig | undefined
  insert(provider: IProviderConfig): void
  update(id: string, patch: TProviderPatch): IProviderConfig | undefined
  delete(id: string): boolean
}

/**
 * Quem responde "como chamo este provider agora?" — o que os adapters, o provider de sessões e o
 * classificador consultam. Junta o provider (protocolo, URL) com a chave em vigor.
 */
export interface IProviderDirectory {
  list(): IProviderConfig[]
  get(id: string): IProviderConfig | undefined
  /** `undefined` para provider que não existe ou está desligado. */
  connection(id: string): IProviderConnection | undefined
}
