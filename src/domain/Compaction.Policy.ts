import { HANDOFF_MAX_CHARS, handoffText, ITranscriptTurn } from './Handoff.Policy'
import { liveLimit } from './models/Limits.Model'

/**
 * ⚖️ A COMPACTAÇÃO DO CONTEXTO: a conversa que passou de N% da janela do modelo recomeça com um RESUMO feito pelo
 * próprio modelo (que viu tudo, inclusive a saída das ferramentas) e os últimos turnos por extenso.
 *
 * Roda no INÍCIO do turno seguinte, e não no fim do que encheu: o resumo e o turno saem juntos, e a conversa que
 * ninguém continua não paga um resumo à toa. O Claude Agent SDK, o Codex e o Antigravity compactam sozinhos
 * (`IAgentAdapter.compactsItself`) e ficam de fora.
 */

export const DEFAULT_COMPACT_AT_PERCENT = 80

/** Os turnos mais recentes que vão por extenso junto do resumo. */
export const COMPACT_KEEP_TURNS = 2

/** O pedido do turno oculto. Não é gravado como turno, e o modelo não deve chamar ferramenta nele. */
export const COMPACT_REQUEST =
  '[Pedido do sistema, não da pessoa: o contexto desta conversa está perto do limite e vai ser trocado por um resumo seu. Escreva o resumo agora, SEM usar ferramentas. Inclua: o objetivo da pessoa; as decisões tomadas e por quê; o estado do trabalho (arquivos mexidos, comandos que importam, o que funcionou e o que falhou); o que falta fazer, na ordem; os fatos exatos que vão ser precisos (caminhos, nomes, ids, valores). Seja específico, sem repetir a conversa. Responda só com o resumo.]'

const COMPACT_INTRO =
  '[Contexto do sistema: esta conversa ficou longa e o contexto foi compactado. Abaixo, o resumo que você mesmo escreveu de tudo até aqui e, por extenso, os últimos turnos. Continue de onde parou, sem responder de novo ao que já foi respondido. A mensagem nova da pessoa vem depois.]'

/** O gatilho em % da janela: o das configurações, senão `COMPACT_AT_PERCENT`, senão 80. */
export function compactAtPercent(env: NodeJS.ProcessEnv = process.env): number {
  const configured = liveLimit('compactAtPercent')
  if (configured !== undefined) return configured
  const parsed = Number.parseInt(env.COMPACT_AT_PERCENT ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 95 ? parsed : DEFAULT_COMPACT_AT_PERCENT
}

/** O contexto da última chamada passou do gatilho. Janela ou contexto desconhecidos: não compacta. */
export function shouldCompact(contextTokens: number | undefined, window: number | undefined, percent = compactAtPercent()): boolean {
  return !!contextTokens && !!window && contextTokens >= (window * percent) / 100
}

/** O bloco que vai antes da mensagem nova: o resumo e os últimos turnos por extenso. */
export function compactHandoff(summary: string, transcript: readonly ITranscriptTurn[], maxChars = HANDOFF_MAX_CHARS): string {
  const resume = summary.trim().slice(0, Math.floor(maxChars / 2))
  const recent = handoffText(transcript.slice(-COMPACT_KEEP_TURNS), maxChars - resume.length)
  // O `handoffText` traz a própria abertura; aqui fica só o corpo dos turnos.
  const turns = recent?.split('\n\n').slice(1, -1).join('\n\n')
  return [COMPACT_INTRO, `## Resumo\n${resume}`, ...(turns ? [`## Últimos turnos\n${turns}`] : []), '[Fim do contexto. Mensagem nova:]'].join('\n\n')
}
