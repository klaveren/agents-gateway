import { EProvider } from '@domain/enums/EProvider.Enum'

/** De onde vem a chave em vigor de um provider. */
export type TCredentialSource = 'stored' | 'env' | 'none'

/** O que a tela pode saber de uma chave — ⛔ nunca a chave. */
export interface ICredentialStatus {
  provider: EProvider
  configured: boolean
  source: TCredentialSource
  /** Os quatro últimos caracteres, para reconhecer qual chave é. Ausente sem chave. */
  last4?: string
  updatedAt?: Date
  updatedBy?: string
  /** Há chave salva, mas ela não decifra (a chave-mestra mudou): cole de novo. */
  unreadable?: boolean
}

/**
 * Quem pergunta "qual a chave deste provider AGORA?". É tudo o que adapter e classificador precisam.
 *
 * ⚖️ PERGUNTADA NA HORA DA CHAMADA, não no construtor: trocar a chave pela tela vale na próxima
 * chamada, sem reiniciar. Turno já em andamento termina com a chave com que começou.
 */
export interface ICredentialSource {
  get(provider: EProvider): string | undefined
}

/**
 * As chaves de API dos providers, configuradas pela tela.
 *
 * ⚖️ SALVA VENCE AMBIENTE: a chave guardada aqui vale sobre a do `.env`; sem chave guardada, vale a do
 * `.env` — quem já roda configurado pelo ambiente não quebra ao atualizar.
 *
 * ⛔ SÓ ESCRITA: nenhum método devolve a chave salva para fora do processo; `status()` mostra só o
 * final dela. ⛔ ESCREVER LANÇA — falhar em silêncio diria "salvo" com a chave antiga valendo.
 */
export interface ICredentialStore extends ICredentialSource {
  status(): ICredentialStatus[]
  save(provider: EProvider, key: string, by: string): void
  clear(provider: EProvider): void
  subscribe(listener: (provider: EProvider) => void): void
}

/** O nome da variável de ambiente de cada provider — a reserva quando não há chave salva. */
export const ENV_KEY_NAME: Record<EProvider, string> = {
  [EProvider.CLAUDE]: 'ANTHROPIC_API_KEY',
  [EProvider.OPENAI]: 'OPENAI_API_KEY',
  [EProvider.GOOGLE]: 'GOOGLE_API_KEY',
}
