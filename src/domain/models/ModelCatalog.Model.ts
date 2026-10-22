import { IModelPrice } from './Model.Pricing'

/**
 * De onde veio o preço de um modelo do catálogo.
 *
 * ⚖️ `manual` VENCE TUDO e sobrevive à sincronização: quem digitou o preço sabe algo que a listagem não
 * diz (um contrato, um desconto). `catalog` é o que o provider informou na listagem; `default` é a tabela
 * de fábrica (`MODEL_PRICING` + `MODEL_PRICING_FILE`), só para os oficiais.
 */
export type TPriceSource = 'manual' | 'catalog' | 'default'

/**
 * Se o modelo raciocina, segundo a listagem do provider.
 *
 * ⚖️ `levels` só quando a listagem diz quais (a Anthropic diz, por modelo); sem ele, valem os do
 * protocolo. `heuristic` = a listagem não diz nada (OpenAI oficial) e o palpite veio do id.
 * AUSENTE = desconhecido, e desconhecido não bloqueia: sem dado, ninguém perde a opção.
 */
export interface IModelReasoning {
  supported: boolean
  levels?: string[]
  source: 'provider' | 'heuristic'
}

/** Um modelo que um provider oferece — e se ele pode ser usado aqui. */
export interface ICatalogModel {
  providerId: string
  modelId: string
  label?: string
  /** Pode ser oferecido por um agente. ⚖️ NASCE DESLIGADO: ninguém usa modelo que não escolheu. */
  enabled: boolean
  /** Apareceu na última listagem do provider. Falso = sumiu de lá; fica registrado, não é apagado. */
  available: boolean
  contextLength?: number
  price?: IModelPrice
  priceSource?: TPriceSource
  reasoning?: IModelReasoning
  syncedAt?: Date
  updatedAt: Date
  updatedBy?: string
}

/** Um modelo como a listagem do provider o descreve. */
export interface IListedModel {
  id: string
  label?: string
  contextLength?: number
  /** Só quando a listagem traz preço (há agregadores que trazem). */
  price?: IModelPrice
  reasoning?: IModelReasoning
}

/**
 * Os níveis que o modelo aceita, dentro dos que o agente oferece. `null` = o catálogo não sabe, e
 * valem os do agente; `[]` = o modelo não raciocina (ou nenhum nível do agente serve a ele).
 */
export function modelReasoningLevels(agentLevels: readonly string[], reasoning: IModelReasoning | undefined): string[] | null {
  if (!reasoning) return null
  if (!reasoning.supported) return []
  return reasoning.levels ? agentLevels.filter((level) => reasoning.levels!.includes(level)) : [...agentLevels]
}
