import { IStoredUsage } from './Conversation.Model'

/**
 * O que um modelo custa, por 1M de tokens, em dólar.
 *
 * ⚖️ ISTO NÃO DECIDE NADA — é rótulo e estimativa. Quem escolhe o modelo é quem opera; ele escolhe
 * melhor vendo o preço ao lado do nome do que abrindo três tabelas de três fornecedores.
 */
export interface IModelPrice {
  /** Dólares por 1M de tokens de entrada (a parte que não veio do cache). */
  input: number
  /** Dólares por 1M de tokens de saída — o raciocínio é cobrado a este preço. */
  output: number
  /** Dólares por 1M de tokens LIDOS do cache. Ausente = lê-se ao preço de entrada. */
  cacheRead?: number
  /**
   * Dólares por 1M de tokens GRAVADOS no cache. Ausente = gravar não é cobrado à parte (cache
   * implícito que só cobra armazenamento). Onde é cobrado, costuma ser ACIMA da entrada.
   */
  cacheWrite?: number
  /** Preço promocional que já tem data para acabar (`AAAA-MM-DD`). Informativo: o cálculo não o lê. */
  introductoryUntil?: string
}

export type TModelPricing = Record<string, IModelPrice>

/**
 * A tabela que acompanha o gateway: os modelos que o registro de agentes declara.
 *
 * ⚠️ NÚMEROS COM DATA, e a data importa: tabela de preço envelhece em silêncio e passa a mentir com a
 * mesma confiança de antes. Conferida em 08/10/2026 nas páginas oficiais de cada fornecedor.
 * `introductoryUntil` marca o que é promocional — depois da data o preço sobe, e a tabela precisa ser
 * revista.
 *
 * ⛔ MODELO FORA DAQUI NÃO TEM PREÇO, e `costOf` devolve `undefined` — nunca um chute. O registro
 * declara `o4-mini` e `o3-pro` sem preço confirmado, de propósito: entram por `MODEL_PRICING_FILE`
 * quando alguém conferir na fonte.
 *
 * A tabela ATIVA de um processo é esta somada ao arquivo de `MODEL_PRICING_FILE` (ver
 * `mergePricing` e `loadPricing`); quem calcula custo recebe a ativa por parâmetro.
 */
export const MODEL_PRICING: TModelPricing = {
  // ── Google ──────────────────────────────────────────────────────────────────
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, introductoryUntil: '2026-12-31' },
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, introductoryUntil: '2026-12-31' },
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0, cacheRead: 0.2 },

  // ── Anthropic ───────────────────────────────────────────────────────────────
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },

  // ── OpenAI ──────────────────────────────────────────────────────────────────
  // ⚠️ `gpt-5.6-terra`: o cache segue a proporção do `gpt-5.6-sol` (leitura 10%, gravação 125% da
  // entrada) — derivado, não conferido na página do fornecedor.
  'gpt-5.6-terra': { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-sol': { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite: 5.0 },
}

/**
 * Custo ESTIMADO de um consumo, em dólar. `undefined` quando o modelo não tem preço na tabela —
 * "sem preço" não pode virar "custou zero".
 *
 * ⚖️ A entrada NOVA é `inputTokens` menos as duas parcelas de cache (o cache é parcela da entrada, não
 * soma a ela); leitura e gravação de cache pagam o preço delas; o RACIOCÍNIO é cobrado como saída.
 *
 * ⚠️ Estimativa com a tabela ATUAL: conversa antiga é cobrada pelo preço de hoje, e conversa gravada
 * sem separar o cache conta tudo como entrada nova (sai acima do real).
 */
export function costOf(model: string, usage: IStoredUsage, pricing: TModelPricing = MODEL_PRICING): number | undefined {
  const price = Object.hasOwn(pricing, model) ? pricing[model] : undefined
  if (!price) return undefined

  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  const fresh = Math.max((usage.inputTokens ?? 0) - read - write, 0)
  const output = (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0)

  return (fresh * price.input + read * (price.cacheRead ?? price.input) + write * (price.cacheWrite ?? price.input) + output * price.output) / 1_000_000
}

/** Preço de saída, para ordenar. Modelo sem preço conhecido vai para o fim, não some. */
export function outputPriceOf(model: string, pricing: TModelPricing = MODEL_PRICING): number {
  return Object.hasOwn(pricing, model) ? pricing[model].output : Number.POSITIVE_INFINITY
}

const NUMERIC_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

/** Problemas de UMA entrada da tabela, em texto. Vazio = válida. */
function problemsOf(model: string, entry: unknown): string[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [`${model}: esperava um objeto`]

  const price = entry as Record<string, unknown>
  const problems: string[] = []

  for (const field of NUMERIC_FIELDS) {
    const value = price[field]
    const required = field === 'input' || field === 'output'

    if (value === undefined) {
      if (required) problems.push(`${model}: falta "${field}"`)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) problems.push(`${model}: "${field}" precisa ser um número não negativo`)
  }

  if (price.introductoryUntil !== undefined && (typeof price.introductoryUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(price.introductoryUntil))) {
    problems.push(`${model}: "introductoryUntil" precisa ser AAAA-MM-DD`)
  }

  return problems
}

export interface IMergedPricing {
  pricing: TModelPricing
  /** Por que o acréscimo foi recusado. Vazio = aplicado. */
  problems: string[]
}

/**
 * A tabela ativa: as de fábrica com `extra` por cima, modelo a modelo (a entrada do arquivo SUBSTITUI
 * a de fábrica inteira, em vez de mesclar campos — preço pela metade é preço errado).
 *
 * ⛔ TUDO OU NADA. Uma entrada inválida recusa o arquivo inteiro e volta às de fábrica, com os
 * problemas listados: aplicar só o que está certo deixaria uma tabela que ninguém escreveu, e custo
 * que se confia sem poder conferir é pior que custo ausente.
 */
export function mergePricing(extra: unknown, base: TModelPricing = MODEL_PRICING): IMergedPricing {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return { pricing: base, problems: ['esperava um objeto { "<modelo>": { input, output, … } }'] }

  const problems = Object.entries(extra).flatMap(([model, entry]) => problemsOf(model, entry))
  if (problems.length) return { pricing: base, problems }

  return { pricing: { ...base, ...(extra as TModelPricing) }, problems: [] }
}
