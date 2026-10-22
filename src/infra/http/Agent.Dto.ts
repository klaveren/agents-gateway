import { IAgent } from '@domain/models/Agent.Model'
import { IModelPrice, MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'

export interface IAgentDto {
  id: string
  name: string
  provider: string
  models: string[]
  /**
   * Preço por 1M de tokens de cada modelo que este agente oferece E que tem preço na tabela.
   *
   * ⚖️ Vai junto da lista, e não numa rota separada, porque quem pede os agentes está montando um
   * seletor — e um seletor de modelo sem preço obriga a pessoa a abrir a tabela do fornecedor para
   * decidir. Só os modelos DESTE agente entram. Modelo sem preço fica de fora (não vira zero): quem
   * ordena do mais barato usa `outputPriceOf`, que o manda para o fim.
   */
  pricing: Record<string, IModelPrice>
  reasoningEfforts?: string[]
  modes: string[]
  allowedTools: string[]
  /** Do código (só leitura) ou criado pela tela. */
  builtIn: boolean
}

/**
 * O agente INTEIRO, com o prompt — só para quem administra, na tela de edição.
 *
 * ⛔ É a exceção ao `toAgentDto`, e mora numa rota própria de administrador: a listagem pública
 * continua sem o prompt.
 */
export interface IAgentDetailDto extends IAgentDto {
  systemPrompt: string
  /** Modelos que o agente declara e que estão DESLIGADOS no catálogo: não são oferecidos até religar. */
  disabledModels?: string[]
  updatedAt?: Date
  updatedBy?: string
}

/**
 * O que a API mostra de um agente — TUDO menos o `systemPrompt`.
 *
 * ⛔ A PERSONA NÃO SAI DAQUI. Devolver o registro cru entregava a instrução inteira do agente — o
 * que ele pode e não pode, o protocolo, as regras — a quem listasse os agentes.
 *
 * ⚖️ É a diferença entre expor a INTERFACE e expor a IMPLEMENTAÇÃO. Quem consome precisa saber que
 * agentes existem, em que provider e modelo e com que lanes — para escolher. Não precisa, em
 * nenhum caso, do texto que instrui o modelo: isso é o produto, não o contrato.
 *
 * Lista explícita de campos, e não `{ ...agent, systemPrompt: undefined }`: campo novo no registry
 * nasce PRIVADO e só sai quando alguém o escreve aqui. Com spread, nasceria público.
 */
export function toAgentDto(agent: IAgent, pricing: TModelPricing = MODEL_PRICING, builtIn = true): IAgentDto {
  return {
    id: agent.id,
    name: agent.name,
    provider: String(agent.provider),
    models: agent.models,
    pricing: Object.fromEntries(agent.models.filter((model) => Object.hasOwn(pricing, model)).map((model) => [model, pricing[model]])),
    reasoningEfforts: agent.reasoningEfforts,
    modes: agent.modes.map(String),
    allowedTools: agent.allowedTools,
    builtIn,
  }
}

export function toAgentDetailDto(
  entry: { agent: IAgent; builtIn: boolean; updatedAt?: Date; updatedBy?: string },
  pricing: TModelPricing = MODEL_PRICING,
  disabledModels: string[] = [],
): IAgentDetailDto {
  return { ...toAgentDto(entry.agent, pricing, entry.builtIn), systemPrompt: entry.agent.systemPrompt, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy, disabledModels }
}
