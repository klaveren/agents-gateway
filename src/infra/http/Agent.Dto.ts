import type { IPermissionRule } from '@domain/Permission.Policy'
import type { IAgentFallback } from '@domain/Fallback.Policy'
import { IAgent, IAgentTerminal } from '@domain/models/Agent.Model'
import { IModelPrice, MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IModelReasoning, modelReasoningLevels } from '@domain/models/ModelCatalog.Model'
import { protocolLevels } from '@domain/Reasoning.Levels'

/** O que o DTO precisa saber de cada provider do agente: nome, protocolo, preços e o raciocínio de cada modelo segundo o catálogo. */
export interface IAgentProviderFacts {
  name?: string
  protocol?: EProvider
  pricing?: TModelPricing
  reasoningOf?(model: string): IModelReasoning | undefined
  /** A janela de contexto de cada modelo, do catálogo. */
  contextOf?(model: string): number | undefined
  /** Só para admin: por que este provider não roda agora. */
  unavailable?: { reason: string; label: string }
  /** Só na tela de edição: os modelos declarados que estão desligados no catálogo. */
  disabledModels?: string[]
}

/** Um provider do agente como a tela o mostra. */
export interface IAgentProviderDto {
  id: string
  /** O NOME do banco, não um rótulo fixo no código. */
  name: string
  protocol?: string
  models: string[]
  /**
   * Preço por 1M de tokens de cada modelo que este provider oferece AO AGENTE e que tem preço na tabela.
   *
   * ⚖️ Vai junto da lista, e não numa rota separada, porque quem pede os agentes está montando um
   * seletor — e um seletor de modelo sem preço obriga a pessoa a abrir a tabela do fornecedor para
   * decidir. ⚖️ POR PROVIDER: o mesmo modelo custa diferente na API e na assinatura. Modelo sem preço
   * fica de fora (não vira zero): quem ordena do mais barato usa `outputPriceOf`, que o manda para o fim.
   */
  pricing: Record<string, IModelPrice>
  /** A janela de contexto (tokens de entrada) de cada modelo que o provider informou. Sem o dado, fica de fora. */
  contextLength: Record<string, number>
  /** Os níveis do agente que o protocolo deste provider aceita, na ordem dele. */
  reasoningEfforts?: string[]
  /**
   * Por modelo: os níveis do agente que AQUELE modelo aceita. `null` = o catálogo não sabe (valem os
   * do provider); `[]` = o modelo não raciocina — a tela esconde o seletor.
   */
  modelReasoning: Record<string, string[] | null>
  /** O sandbox escolhido para este provider (só nos que têm, ver `SANDBOX_LEVELS`). */
  sandbox?: string
  /** Rede liberada no sandbox. */
  network?: boolean
  disabledModels?: string[]
  unavailable?: { reason: string; label: string }
}

export interface IAgentDto {
  id: string
  name: string
  /** Onde o agente roda. O PRIMEIRO é o padrão; a conversa troca entre eles no meio. */
  providers: IAgentProviderDto[]
  /** Os níveis de raciocínio que o agente oferece (cada provider usa os do seu protocolo). */
  reasoningEfforts?: string[]
  modes: string[]
  allowedTools: string[]
  /** `subagent`: só chamado por outro agente; não abre conversa direta. */
  role?: string
  /** Só administrador conversa com o agente (marcado por quem o criou). */
  adminOnly?: boolean
  /** O projeto do agente; ausente = global. */
  projectId?: string
}

/**
 * O agente INTEIRO, com o prompt — só para quem administra, na tela de edição.
 *
 * ⛔ É a exceção ao `toAgentDto`, e mora numa rota própria de administrador: a listagem pública
 * continua sem o prompt.
 */
export interface IAgentDetailDto extends IAgentDto {
  systemPrompt: string
  /** Quem o agente é (personalidade). Só para quem administra, como o prompt. */
  soul?: string
  /** As regras de permissão do agente (a camada dele). Só para quem administra. */
  permissions?: IPermissionRule[]
  terminal?: IAgentTerminal
  fallback?: IAgentFallback
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
 * agentes existem, em que providers e modelos e com que lanes — para escolher. Não precisa, em
 * nenhum caso, do texto que instrui o modelo: isso é o produto, não o contrato.
 *
 * Lista explícita de campos, e não `{ ...agent, systemPrompt: undefined }`: campo novo no agente
 * nasce PRIVADO e só sai quando alguém o escreve aqui. Com spread, nasceria público.
 */
export function toAgentDto(agent: IAgent, factsOf: (providerId: string) => IAgentProviderFacts = () => ({})): IAgentDto {
  return {
    id: agent.id,
    name: agent.name,
    providers: agent.providers.map((target) => {
      const facts = factsOf(target.provider)
      const pricing = facts.pricing ?? MODEL_PRICING
      const efforts = facts.protocol ? protocolLevels(facts.protocol, agent.reasoningEfforts ?? []) : (agent.reasoningEfforts ?? [])
      return {
        id: target.provider,
        name: facts.name ?? target.provider,
        ...(facts.protocol ? { protocol: facts.protocol } : {}),
        models: target.models,
        pricing: Object.fromEntries(target.models.filter((model) => Object.hasOwn(pricing, model)).map((model) => [model, pricing[model]])),
        contextLength: Object.fromEntries(
          target.models.flatMap((model) => {
            const size = facts.contextOf?.(model)
            return size ? [[model, size]] : []
          }),
        ),
        reasoningEfforts: efforts.length ? efforts : undefined,
        modelReasoning: Object.fromEntries(target.models.map((model) => [model, efforts.length ? modelReasoningLevels(efforts, facts.reasoningOf?.(model)) : []])),
        ...(target.sandbox ? { sandbox: target.sandbox } : {}),
        ...(target.network ? { network: true } : {}),
        ...(facts.disabledModels?.length ? { disabledModels: facts.disabledModels } : {}),
        ...(facts.unavailable ? { unavailable: facts.unavailable } : {}),
      }
    }),
    reasoningEfforts: agent.reasoningEfforts?.length ? agent.reasoningEfforts : undefined,
    modes: agent.modes.map(String),
    allowedTools: agent.allowedTools,
    ...(agent.role ? { role: agent.role } : {}),
    ...(agent.adminOnly ? { adminOnly: true } : {}),
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
  }
}

export function toAgentDetailDto(
  entry: { agent: IAgent; updatedAt?: Date; updatedBy?: string },
  factsOf: (providerId: string) => IAgentProviderFacts = () => ({}),
): IAgentDetailDto {
  return {
    ...toAgentDto(entry.agent, factsOf),
    systemPrompt: entry.agent.systemPrompt,
    soul: entry.agent.soul,
    ...(entry.agent.permissions?.length ? { permissions: entry.agent.permissions } : {}),
    ...(entry.agent.terminal ? { terminal: entry.agent.terminal } : {}),
    ...(entry.agent.fallback ? { fallback: entry.agent.fallback } : {}),
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
  }
}
