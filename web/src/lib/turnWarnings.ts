/**
 * Os avisos de um turno como a pessoa os vê: o "Compactando o contexto…" é provisório e sai quando chega o resultado da
 * compactação (concluída ou falhou), para não ficarem os dois.
 */
const COMPACTING = /^Compactando o contexto/
const COMPACTION_RESULT = /^(Contexto compactado|O resumo do contexto falhou)/

export function visibleWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning, index) => !COMPACTING.test(warning) || !warnings.slice(index + 1).some((later) => COMPACTION_RESULT.test(later)))
}
