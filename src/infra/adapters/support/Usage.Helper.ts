/**
 * Uma parcela de cache de dentro dos detalhes de entrada da OpenAI: `cached_tokens` (lido) ou
 * `cache_write_tokens` (gravado).
 *
 * ⚠️ O SDK entrega esse detalhe ora como objeto, ora como LISTA de objetos (um por chamada ao
 * modelo), com a chave crua da API. Lê as duas formas, e a variante camelCase por garantia. As duas
 * parcelas já estão dentro da entrada (`inputTokens` / `prompt_tokens`).
 */
export function cacheTokensOf(details: unknown, key: 'cached_tokens' | 'cache_write_tokens'): number {
  const camel = key === 'cached_tokens' ? 'cachedTokens' : 'cacheWriteTokens'
  const entries = Array.isArray(details) ? details : [details]

  return entries.reduce<number>((total, entry) => {
    if (typeof entry !== 'object' || entry === null) return total
    const value = (entry as Record<string, unknown>)[key] ?? (entry as Record<string, unknown>)[camel]

    return total + (typeof value === 'number' ? value : 0)
  }, 0)
}
