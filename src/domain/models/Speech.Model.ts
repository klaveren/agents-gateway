import { PERSON_MESSAGE_LEVELS, TPersonMessageLevel } from './PersonMessage.Model'

/**
 * 🔊 A VOZ DAS MENSAGENS: as preferências de cada pessoa para ouvir o que os agentes lhe escrevem (ver `Speech.Service`) e o
 * texto que vai para o modelo de voz. O motor (provider, modelo, voz padrão) é do admin, nas Configurações.
 */
export interface IVoicePreferences {
  /** Ler as mensagens em voz alta. Desligado por padrão: ninguém começa a ouvir sem pedir. */
  enabled: boolean
  /** A voz da pessoa; ausente = a padrão do admin. */
  voice?: string
  /** A velocidade (0,5 a 2). */
  rate: number
  /** A partir de que nível ler (`info` lê todas). */
  minLevel: TPersonMessageLevel
}

export const VOICE_RATE = { min: 0.5, max: 2 } as const
export const DEFAULT_VOICE_PREFERENCES: IVoicePreferences = { enabled: false, rate: 1, minLevel: 'info' }
export const VOICE_VOICE_MAX = 80

/** O nível 0 (`info`), 1 (`attention`), 2 (`urgent`): quanto maior, mais importante. */
export function levelRank(level: TPersonMessageLevel): number {
  return PERSON_MESSAGE_LEVELS.indexOf(level)
}

/** A mensagem deste nível passa pelo piso da pessoa? */
export function levelAtLeast(level: TPersonMessageLevel, minimum: TPersonMessageLevel): boolean {
  return levelRank(level) >= levelRank(minimum)
}

/** O que está gravado, com os padrões onde faltar ou vier torto (documento editado à mão não derruba a leitura). */
export function normalizeVoicePreferences(raw: unknown): IVoicePreferences {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const rate = typeof stored.rate === 'number' && Number.isFinite(stored.rate) ? Math.min(VOICE_RATE.max, Math.max(VOICE_RATE.min, stored.rate)) : DEFAULT_VOICE_PREFERENCES.rate
  const voice = typeof stored.voice === 'string' && stored.voice.trim() ? stored.voice.trim().slice(0, VOICE_VOICE_MAX) : undefined
  return {
    enabled: stored.enabled === true,
    ...(voice ? { voice } : {}),
    rate,
    minLevel: (PERSON_MESSAGE_LEVELS as readonly string[]).includes(stored.minLevel as string) ? (stored.minLevel as TPersonMessageLevel) : DEFAULT_VOICE_PREFERENCES.minLevel,
  }
}

/** A frase do botão "Testar" do Perfil. */
export const SPEECH_SAMPLE_TEXT = 'Olá! É assim que vou ler as suas mensagens.'

/** O teto do texto falado: mensagem longa vira um trecho e o resto fica na tela. */
export const SPEECH_MAX_CHARS = 1200
const SPEECH_TAIL = ' — o restante está na tela.'

/** Markdown vira fala: o que é só marcação some, o que é conteúdo fica. */
export function stripMarkdown(markdown: string): string {
  return (
    markdown
      // Blocos de código (cercados) viram um aviso: ninguém quer ouvir código.
      .replace(/```[\s\S]*?(```|$)/g, ' trecho de código. ')
      .replace(/~~~[\s\S]*?(~~~|$)/g, ' trecho de código. ')
      // Imagem: só o texto alternativo. Link: o texto dele.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Código em linha: o conteúdo.
      .replace(/`([^`]*)`/g, '$1')
      // URLs soltas e e-mails entre sinais.
      .replace(/<?https?:\/\/[^\s>)]+>?/gi, ' ')
      // Títulos, citações, itens de lista (com marcador ou número) e linhas horizontais.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
      // Tabelas: as barras viram pausas.
      .replace(/\|/g, ', ')
      // Negrito, itálico e riscado.
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      // Tags HTML.
      .replace(/<[^>]+>/g, ' ')
  )
}

/** De onde a mensagem vem, para a abertura da leitura: o nome do agente e o título da conversa. */
export interface ISpeechOrigin {
  agent?: string
  conversation?: string
}

/**
 * O texto que se fala de uma mensagem: a abertura ("Mensagem de Zeus, da conversa X."), o título (se houver) e o corpo
 * sem Markdown, espaços colapsados, cortado numa fronteira de frase perto de `SPEECH_MAX_CHARS` com o aviso de que o
 * resto está na tela.
 */
export function speechText(message: { title?: string; body: string }, origin: ISpeechOrigin = {}): string {
  const clean = (text: string) => stripMarkdown(text).replace(/\s+/g, ' ').trim()
  const title = message.title ? clean(message.title) : ''
  const body = clean(message.body)
  const agent = origin.agent ? clean(origin.agent) : ''
  const conversation = origin.conversation ? clean(origin.conversation).replace(/[.!?:]+$/, '') : ''
  const intro = agent || conversation ? `Mensagem${agent ? ` de ${agent}` : ''}${conversation ? `, da conversa ${conversation}` : ''}. ` : ''
  const joined = intro + (title && body ? `${title.replace(/[.!?:]+$/, '')}. ${body}` : title || body)
  if (joined.length <= SPEECH_MAX_CHARS) return joined
  const room = SPEECH_MAX_CHARS - SPEECH_TAIL.length
  const head = joined.slice(0, room)
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  // Sem frase inteira que valha (menos de um terço), corta na última palavra.
  const cut = sentenceEnd >= room / 3 ? head.slice(0, sentenceEnd + 1) : head.slice(0, Math.max(head.lastIndexOf(' '), 0) || room).trimEnd()
  return `${cut.replace(/[,;:\s]+$/, '')}${SPEECH_TAIL}`
}
