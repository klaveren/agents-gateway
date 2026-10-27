import { IAgentHook, IHookDelivery } from '@domain/models/AgentHook.Model'

export type TAgentHookPatch = Partial<
  Pick<IAgentHook, 'prompt' | 'enabled' | 'verify' | 'signatureHeader' | 'signaturePrefix' | 'signatureEncoding' | 'session' | 'sessionId' | 'updatedAt' | 'updatedBy'>
>

/** Onde ficam os hooks dos agentes e as últimas chamadas de cada um. Síncrono, como o resto do cadastro. */
export interface IAgentHookRepository {
  list(agentId: string): IAgentHook[]
  get(agentId: string, name: string): IAgentHook | undefined
  insert(hook: IAgentHook): void
  update(agentId: string, name: string, patch: TAgentHookPatch): IAgentHook | undefined
  delete(agentId: string, name: string): boolean
  /** Apaga os hooks de um agente (o agente foi apagado) e devolve os nomes. */
  deleteAgent(agentId: string): string[]
  addDelivery(delivery: IHookDelivery): void
  updateDelivery(id: string, patch: Partial<Pick<IHookDelivery, 'status' | 'sessionId' | 'error'>>): void
  /** As últimas, da mais nova para a mais velha. */
  deliveries(agentId: string, name: string, limit?: number): IHookDelivery[]
}
