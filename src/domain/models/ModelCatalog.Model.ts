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

/**
 * 🖼️ Se o modelo GERA IMAGEM, segundo a listagem do provider (`architecture.output_modalities`, nos compatíveis
 * com OpenRouter) ou, sem ela, o palpite pelo id (`heuristic`). `only` = só gera imagem (não conversa): fica
 * fora das listas de modelo de conversa.
 */
export interface IModelImage {
  output: boolean
  only?: boolean
  source: 'provider' | 'heuristic'
}

/** Só imagem: os modelos de imagem da OpenAI (o endpoint `/images`). */
const IMAGE_ONLY = /^(gpt-image|chatgpt-image|dall-e)/i
/** Gera imagem: os acima e os Gemini de imagem (`generateContent` com saída de imagem). */
const IMAGE_OUTPUT = /^(gpt-image|chatgpt-image|dall-e)|(^|\/)gemini-[\w.-]*image/i

/** O palpite pelo id, para quando a listagem não diz (OpenAI, Google, Anthropic). */
export function guessModelImage(modelId: string): IModelImage {
  return { output: IMAGE_OUTPUT.test(modelId), ...(IMAGE_ONLY.test(modelId) ? { only: true } : {}), source: 'heuristic' }
}

/** O que a listagem disse; sem nada, o palpite. Vale também para o que foi gravado antes de haver o campo. */
export function modelImage(model: { modelId: string; image?: IModelImage }): IModelImage {
  return model.image ?? guessModelImage(model.modelId)
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
  image?: IModelImage
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
  image?: IModelImage
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
