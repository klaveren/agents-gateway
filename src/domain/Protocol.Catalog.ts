import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { ENV_KEY_NAME } from './ports/CredentialStore.Port'
import { REASONING_LEVELS } from './Reasoning.Levels'
import { isSubscription, lanesOf, nativeFamily } from './Subscription.Policy'

/** O que a tela precisa saber de um protocolo — e não copia mais. */
export interface IProtocolInfo {
  id: EProvider
  label: string
  /** Assinatura: login no host, sem chave de API, só a lane agent. */
  subscription: boolean
  lanes: readonly EMode[]
  /** Do menor ao maior; vazio = sem controle de raciocínio (ver `REASONING_LEVELS`). */
  reasoningLevels: readonly string[]
  /** De quem são as nativas `sdk:…` que ele roda (o Claude da assinatura roda as do Claude). */
  nativeFamily: EProvider
  /** O fabricante, para a cor e o ícone: `claude`, `openai` ou `google`. */
  brand: EProvider.CLAUDE | EProvider.OPENAI | EProvider.GOOGLE
  /** Onde se cria a chave de API. Ausente nas assinaturas. */
  consoleUrl?: string
  /** A variável do `.env` importada para o cofre no primeiro boot. Ausente nas assinaturas. */
  envName?: string
}

const LABEL: Readonly<Record<EProvider, string>> = {
  [EProvider.CLAUDE]: 'Anthropic',
  [EProvider.OPENAI]: 'OpenAI',
  [EProvider.GOOGLE]: 'Gemini',
  [EProvider.CLAUDE_SUB]: 'Claude Code',
  [EProvider.CODEX]: 'Codex',
  [EProvider.ANTIGRAVITY]: 'Antigravity',
}

const BRAND: Readonly<Record<EProvider, IProtocolInfo['brand']>> = {
  [EProvider.CLAUDE]: EProvider.CLAUDE,
  [EProvider.OPENAI]: EProvider.OPENAI,
  [EProvider.GOOGLE]: EProvider.GOOGLE,
  [EProvider.CLAUDE_SUB]: EProvider.CLAUDE,
  [EProvider.CODEX]: EProvider.OPENAI,
  [EProvider.ANTIGRAVITY]: EProvider.GOOGLE,
}

const CONSOLE_URL: Readonly<Partial<Record<EProvider, string>>> = {
  [EProvider.CLAUDE]: 'https://console.anthropic.com/settings/keys',
  [EProvider.OPENAI]: 'https://platform.openai.com/api-keys',
  [EProvider.GOOGLE]: 'https://aistudio.google.com/apikey',
}

/** Todos os protocolos, na ordem do enum. A fonte é o domínio: lanes, níveis e assinatura são as regras dele. */
export function protocolCatalog(): IProtocolInfo[] {
  return Object.values(EProvider).map((id) => ({
    id,
    label: LABEL[id],
    subscription: isSubscription(id),
    lanes: lanesOf(id),
    reasoningLevels: REASONING_LEVELS[id],
    nativeFamily: nativeFamily(id),
    brand: BRAND[id],
    ...(CONSOLE_URL[id] ? { consoleUrl: CONSOLE_URL[id] } : {}),
    ...(ENV_KEY_NAME[id] ? { envName: ENV_KEY_NAME[id] } : {}),
  }))
}
