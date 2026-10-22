import { EProvider } from '../enums/EProvider.Enum'

/**
 * Um provider configurado: de quem é a API, em que PROTOCOLO ela fala e onde ela mora.
 *
 * ⚖️ O ID E O PROTOCOLO SÃO COISAS DISTINTAS. `EProvider` passa a ser o protocolo — é ele que escolhe o
 * adapter (o SDK da Anthropic, da OpenAI ou do Gemini). O `id` é o provider em si: o oficial `claude`
 * fala `claude`, e um `openrouter` também pode falar `claude` (Anthropic-compatível) ou `openai`.
 * Os três oficiais têm id igual ao protocolo, e é isso que mantém válidos os agentes e as conversas
 * gravados antes de os providers virarem dado.
 */
export interface IProviderConfig {
  id: string
  name: string
  protocol: EProvider
  /** Vazio nos oficiais (o SDK sabe onde é). Obrigatório nos compatíveis. */
  baseUrl?: string
  /** Um dos três oficiais: não se apaga, e o protocolo e a URL não mudam. */
  official: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** Tudo o que um adapter precisa para chamar a API de um provider AGORA. */
export interface IProviderConnection {
  providerId: string
  name: string
  protocol: EProvider
  baseUrl?: string
  /** Ausente = sem chave nenhuma (nem salva, nem no `.env`). */
  key?: string
}

export const OFFICIAL_PROVIDERS: ReadonlyArray<Pick<IProviderConfig, 'id' | 'name' | 'protocol'>> = [
  { id: 'claude', name: 'Claude (Anthropic)', protocol: EProvider.CLAUDE },
  { id: 'openai', name: 'OpenAI', protocol: EProvider.OPENAI },
  { id: 'google', name: 'Gemini (Google)', protocol: EProvider.GOOGLE },
]
