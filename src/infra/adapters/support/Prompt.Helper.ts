import { IAgent } from '@domain/models/Agent.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'

const DEFAULT_MAX_OUTPUT_TOKENS = 4096

/**
 * Compõe o system prompt uma única vez, na criação da sessão.
 *
 * Antes cada adapter fazia isso do seu jeito: o Claude reanexava a instrução de
 * idioma a cada turno e o Google mandava o prompt duas vezes (no history e em
 * `systemInstruction`).
 */
export function composeSystemPrompt(agent: IAgent, input: ICreateSessionInput): string {
  const base = input.systemPrompt?.trim() || agent.systemPrompt
  if (!input.language) return base
  return `${base}\n\nIMPORTANT: Please reply exclusively in ${input.language}.`
}

export function maxOutputTokens(): number {
  const parsed = Number.parseInt(process.env.MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS
}

const DEFAULT_MAX_TOOL_TURNS = 12

/** Teto de idas e voltas de tool num turno. O loop antigo, feito à mão, não tinha nenhum. */
export function maxToolTurns(): number {
  const parsed = Number.parseInt(process.env.MAX_TOOL_TURNS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_TURNS
}
