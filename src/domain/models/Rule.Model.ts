/**
 * Uma RULE: uma regra do ambiente que todo agente respeita ("Rule 1", "Rule 2"…).
 *
 * ⚖️ GLOBAL OU DO PROJETO: sem `projectId`, vale em todos os projetos; com, só no dele. A conversa recebe as
 * globais e depois as do projeto dela, no system prompt, na criação (ver `Guidance.Service.environmentFor`).
 */
export interface IRule {
  id: string
  /** Ausente = global. */
  projectId?: string
  /** A numeração dentro do escopo (1, 2, 3…): é o "N" de "Rule N". */
  position: number
  title: string
  body: string
  /** Desligada fica no cadastro e fora do prompt. */
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

export const RULE_TITLE_MAX = 120
