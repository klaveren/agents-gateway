import { IAgent } from '@domain/models/Agent.Model'

/** Um agente criado pela tela, com quem e quando mexeu por último. */
export interface IStoredAgent extends IAgent {
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/**
 * Onde moram os agentes — todos, a semente (`Agent.Seed`) inclusive.
 *
 * ⚖️ SÍNCRONO, ao contrário dos outros repositórios: o agente é procurado no caminho de TODA sessão
 * nova e de toda listagem, e o driver (`node:sqlite`) já é síncrono — um `await` aqui só espalharia
 * assincronia por quem hoje pergunta "esse agente existe?" sem esperar nada.
 *
 * ⛔ LER NUNCA DERRUBA: banco fora do ar lista vazio, e o resto do gateway segue. ESCREVER
 * lança: é ação de quem administra, e falhar em silêncio diria "salvo" sem ter salvo.
 */
export interface IAgentRepository {
  list(): IStoredAgent[]
  save(agent: IAgent, by: string): IStoredAgent
  /** `true` se havia o que apagar. */
  delete(id: string): boolean
  /** Grava a semente de primeiro boot, uma vez por banco. Agente apagado depois não volta. */
  seedOnce(agents: readonly IAgent[], by: string): void
}

/**
 * Quem responde "que agentes existem".
 *
 * É o que o provider e o controller consultam: nenhum dos dois sabe de onde o agente veio.
 */
export interface IAgentDirectory {
  list(): IAgent[]
  get(id: string): IAgent | undefined
  /** O agente quando ninguém escolheu: o primeiro que pode abrir conversa e não é subagente. */
  fallback?(): IAgent | undefined
}
