import { IAgent } from '@domain/models/Agent.Model'

export interface IAgentDto {
  id: string
  name: string
  provider: string
  models: string[]
  reasoningEfforts?: string[]
  modes: string[]
  allowedTools: string[]
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
export function toAgentDto(agent: IAgent): IAgentDto {
  return {
    id: agent.id,
    name: agent.name,
    provider: String(agent.provider),
    models: agent.models,
    reasoningEfforts: agent.reasoningEfforts,
    modes: agent.modes.map(String),
    allowedTools: agent.allowedTools,
  }
}
