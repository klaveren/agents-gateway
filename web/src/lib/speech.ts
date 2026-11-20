import type { IPersonMessage } from '@/stores/messages'

export type TVoiceLevel = 'info' | 'attention' | 'urgent'

/** `GET /me/voice`: as preferências da pessoa e se o administrador configurou o motor. */
export interface IVoice {
  enabled: boolean
  voice?: string
  rate: number
  minLevel: TVoiceLevel
  engine: { available: boolean; defaultVoice?: string }
}

const LEVELS: TVoiceLevel[] = ['info', 'attention', 'urgent']

/** Este nível passa pelo piso da pessoa? (`info` < `attention` < `urgent`) */
export function levelAtLeast(level: TVoiceLevel, minimum: TVoiceLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minimum)
}

/**
 * As mensagens de um fio que se fala agora: só as do AGENTE, de depois que a tela abriu (o que já estava na caixa não vira
 * leitura de uma vez), no nível da pessoa e ainda não enfileiradas — da mais antiga para a mais nova.
 */
export function speakable(messages: IPersonMessage[], options: { since: number; minLevel: TVoiceLevel; seen: ReadonlySet<string> }): IPersonMessage[] {
  return messages
    .filter((message) => message.from === 'agent' && !options.seen.has(message.id) && Date.parse(message.createdAt) >= options.since && levelAtLeast(message.level, options.minLevel))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** Um áudio mudo e curto: tocá-lo no clique libera o som que o navegador bloqueia até a pessoa interagir. */
export const SILENT_AUDIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
