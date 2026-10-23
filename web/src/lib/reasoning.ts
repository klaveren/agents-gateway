/**
 * Os níveis de raciocínio de cada protocolo, do menor ao maior — o espelho de `src/domain/Reasoning.Levels.ts`
 * (o servidor recusa com 422 o que não estiver lá). Google vazio: o SDK usado não controla raciocínio.
 */
export const REASONING_LEVELS: Record<string, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  google: [],
  'claude-sub': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  // No Antigravity o nível vem no id do modelo (`gemini-4-argon-high`).
  antigravity: [],
}

/** Os protocolos de assinatura: só a lane agent (espelho de `src/domain/Subscription.Policy.ts`). */
export const SUBSCRIPTION_PROTOCOLS: readonly string[] = ['claude-sub', 'codex', 'antigravity']

/** Os níveis escolhidos que o protocolo aceita, na ordem dele. */
export function levelsFor(protocol: string, chosen: readonly string[]): string[] {
  return (REASONING_LEVELS[protocol] ?? []).filter((level) => chosen.includes(level))
}
