import { EProvider } from './enums/EProvider.Enum'

/**
 * Os níveis de raciocínio que cada PROTOCOLO aceita, do menor ao maior — a fonte única dos adapters, da
 * regra do agente e da tela.
 *
 * ⚠️ GOOGLE VAZIO DE PROPÓSITO: o `@google/generative-ai` 0.24 e o ADK não têm controle de raciocínio;
 * o modelo decide sozinho. Oferecer um nível ali seria um seletor que não faz nada.
 */
export const REASONING_LEVELS: Record<EProvider, readonly string[]> = {
  [EProvider.CLAUDE]: ['low', 'medium', 'high', 'xhigh', 'max'],
  [EProvider.OPENAI]: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  [EProvider.GOOGLE]: [],
  [EProvider.CLAUDE_SUB]: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `modelReasoningEffort` do Codex SDK.
  [EProvider.CODEX]: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  // ⚠️ VAZIO DE PROPÓSITO: no Antigravity o nível é parte do id do modelo (`gemini-4-argon-high`).
  [EProvider.ANTIGRAVITY]: [],
}

/** O nível pedido, se o protocolo o aceita; senão `undefined` (o provider usa o padrão dele). */
export function reasoningLevel(protocol: EProvider, requested: string | undefined): string | undefined {
  return requested && REASONING_LEVELS[protocol].includes(requested) ? requested : undefined
}

/** Os níveis na ordem do protocolo, sem os que ele não aceita. */
export function protocolLevels(protocol: EProvider, levels: readonly string[]): string[] {
  return REASONING_LEVELS[protocol].filter((level) => levels.includes(level))
}
