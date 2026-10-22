import { readFileSync } from 'node:fs'
import { MODEL_PRICING, mergePricing, TModelPricing } from '@domain/models/Model.Pricing'

/**
 * A tabela de preços ativa: as de fábrica, mais o que `MODEL_PRICING_FILE` acrescentar ou trocar.
 *
 * ⚖️ ARQUIVO, e não variável com o JSON dentro: preço muda por fornecedor e por data, e é revisado
 * por quem opera — editar um arquivo e reiniciar é o ciclo que se espera, sem rebuild. Lido UMA vez,
 * no boot.
 *
 * ⛔ ARQUIVO QUE NÃO SERVE NUNCA DERRUBA O BOOT, e nunca é aplicado pela metade: ilegível, JSON
 * inválido ou qualquer entrada fora do formato avisam no log e o gateway segue com as de fábrica. O
 * custo é só informação; um erro de digitação num preço não pode tirar o atendimento do ar.
 *
 * `warn` é injetável para o teste conferir o aviso sem sujar a saída.
 */
export function loadPricing(
  file: string | undefined = process.env.MODEL_PRICING_FILE?.trim(),
  warn: (message: string) => void = (message) => console.warn(message),
): TModelPricing {
  if (!file) return MODEL_PRICING

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    warn(`[pricing] MODEL_PRICING_FILE (${file}) ilegível; seguindo com os preços de fábrica. ${error instanceof Error ? error.message : String(error)}`)
    return MODEL_PRICING
  }

  const { pricing, problems } = mergePricing(raw)
  if (problems.length) warn(`[pricing] MODEL_PRICING_FILE (${file}) recusado; seguindo com os preços de fábrica. ${problems.join('; ')}`)

  return pricing
}
