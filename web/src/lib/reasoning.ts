/**
 * Os níveis de raciocínio de cada protocolo, do menor ao maior — o espelho de `src/domain/Reasoning.Levels.ts`
 * (o servidor recusa com 422 o que não estiver lá). Google vazio: o SDK usado não controla raciocínio.
 */
export const REASONING_LEVELS: Record<string, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  google: [],
}

/** Os níveis escolhidos que o protocolo aceita, na ordem dele. */
export function levelsFor(protocol: string, chosen: readonly string[]): string[] {
  return (REASONING_LEVELS[protocol] ?? []).filter((level) => chosen.includes(level))
}
