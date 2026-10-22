/** De onde vem a chave em vigor de um provider. */
export type TCredentialSource = 'stored' | 'env' | 'none'

/** O que a tela pode saber de uma chave — ⛔ nunca a chave. */
export interface ICredentialStatus {
  /** O id do provider configurado (`claude`, `openai`, `google`, `openrouter`…). */
  provider: string
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
 * Quem pergunta "qual a chave deste provider AGORA?".
 *
 * ⚖️ PERGUNTADA NA HORA DA CHAMADA, não no construtor: trocar a chave pela tela vale na próxima
 * chamada, sem reiniciar. Turno já em andamento termina com a chave com que começou.
 */
export interface ICredentialSource {
  get(providerId: string): string | undefined
}

/**
 * As chaves de API dos providers, configuradas pela tela, por id de provider.
 *
 * ⚖️ SALVA VENCE AMBIENTE: a chave guardada aqui vale sobre a do `.env`; sem chave guardada, vale a do
 * `.env` — só para os três oficiais, que são os que têm variável (`ENV_KEY_NAME`).
 *
 * ⛔ SÓ ESCRITA: nenhum método devolve a chave salva para fora do processo; `status()` mostra só o
 * final dela. ⛔ ESCREVER LANÇA — falhar em silêncio diria "salvo" com a chave antiga valendo.
 */
export interface ICredentialStore extends ICredentialSource {
  status(providerIds: readonly string[]): ICredentialStatus[]
  save(providerId: string, key: string, by: string): void
  clear(providerId: string): void
  subscribe(listener: (providerId: string) => void): void
}

/** A variável de ambiente de cada provider OFICIAL — a reserva quando não há chave salva. */
export const ENV_KEY_NAME: Readonly<Record<string, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
}
