import { IModelPrice } from './Model.Pricing'

/**
 * De onde veio o preço de um modelo do catálogo.
 *
 * ⚖️ `manual` VENCE TUDO e sobrevive à sincronização: quem digitou o preço sabe algo que a listagem não
 * diz (um contrato, um desconto). `catalog` é o que o provider informou na listagem; `default` é a tabela
 * de fábrica (`MODEL_PRICING` + `MODEL_PRICING_FILE`), só para os oficiais.
 */
export type TPriceSource = 'manual' | 'catalog' | 'default'

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
}
