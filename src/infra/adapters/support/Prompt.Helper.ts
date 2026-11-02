import { ambientSection } from '@domain/Ambient.Policy'
import { liveLimit, UNLIMITED } from '@domain/models/Limits.Model'
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
/**
 * O prompt que o modelo recebe: o soul (quem o agente é) e as instruções (o que ele faz).
 *
 * ⚖️ UM PONTO SÓ para as seis lanes. O soul vale mesmo quando a sessão traz um prompt próprio
 * (`input.systemPrompt`): troca-se a tarefa, não a identidade do agente.
 */
export function composeSystemPrompt(agent: IAgent, input: ICreateSessionInput): string {
  const instructions = input.systemPrompt?.trim() || agent.systemPrompt
  const soul = agent.soul?.trim()
  const identity = soul ? `## Quem você é\n${soul}\n\n## Como você trabalha\n${instructions}` : instructions
  // Onde ele opera (agente, projeto, diretório) e, depois, as regras do ambiente e os documentos: valem para qualquer tarefa.
  const ambient = input.ambient ? ambientSection(input.ambient) : undefined
  const base = [identity, ambient, input.environment?.trim()].filter(Boolean).join('\n\n')
  if (!input.language) return base
  return `${base}\n\nIMPORTANT: Please reply exclusively in ${input.language}.`
}

/** Teto de tokens de saída por resposta: o das configurações, senão `MAX_OUTPUT_TOKENS`, senão o padrão. */
export function maxOutputTokens(): number {
  const configured = liveLimit('maxOutputTokens')
  if (configured) return configured
  const parsed = Number.parseInt(process.env.MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS
}

const DEFAULT_MAX_TOOL_TURNS = 12

/**
 * Teto de idas e voltas de tool num turno. `undefined` = SEM TETO (-1 na tela ou no `.env`): o turno segue até o
 * modelo responder, o detector de laço parar ou a pessoa apertar parar.
 */
export function maxToolTurns(): number | undefined {
  const configured = liveLimit('maxToolTurns')
  if (configured === UNLIMITED) return undefined
  if (configured) return configured
  const parsed = Number.parseInt(process.env.MAX_TOOL_TURNS ?? '', 10)
  if (parsed === UNLIMITED) return undefined
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_TURNS
}
