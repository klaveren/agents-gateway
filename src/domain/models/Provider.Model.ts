import { EProvider } from '../enums/EProvider.Enum'

/**
 * Um provider configurado: de quem é a API, em que PROTOCOLO ela fala e onde ela mora.
 *
 * ⚖️ O ID E O PROTOCOLO SÃO COISAS DISTINTAS. `EProvider` passa a ser o protocolo — é ele que escolhe o
 * adapter (o SDK da Anthropic, da OpenAI ou do Gemini). O `id` é o provider em si: o oficial `claude`
 * fala `claude`, e um compatível qualquer (`meu-gateway`) também pode falar `claude` (Anthropic-compatível) ou `openai`.
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

/**
 * Os nomes dizem COMO se paga: pela empresa (Anthropic, OpenAI, Google) é por token, com chave de API; pelo produto
 * (Claude, Codex, Gemini) é pela assinatura de uma pessoa. ⚖️ Os de assinatura nascem DESLIGADOS: usam a conta pessoal
 * de quem fez o login no host.
 */
export const OFFICIAL_PROVIDERS: ReadonlyArray<Pick<IProviderConfig, 'id' | 'name' | 'protocol' | 'enabled'>> = [
  { id: 'claude', name: 'Anthropic', protocol: EProvider.CLAUDE, enabled: true },
  { id: 'openai', name: 'OpenAI', protocol: EProvider.OPENAI, enabled: true },
  { id: 'google', name: 'Google', protocol: EProvider.GOOGLE, enabled: true },
  { id: 'claude-sub', name: 'Claude', protocol: EProvider.CLAUDE_SUB, enabled: false },
  { id: 'codex', name: 'Codex', protocol: EProvider.CODEX, enabled: false },
  { id: 'antigravity', name: 'Gemini', protocol: EProvider.ANTIGRAVITY, enabled: false },
]

/** Os nomes de antes dos oficiais: quem ainda tem um deles (não renomeou) passa ao nome de agora. */
export const LEGACY_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude (Anthropic)',
  google: 'Gemini (Google)',
  'claude-sub': 'Claude (assinatura)',
  codex: 'ChatGPT (assinatura)',
  antigravity: 'Antigravity (assinatura)',
}
