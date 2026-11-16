import { IAgenticScope } from '@domain/Import.Scope'

/**
 * Um PROJETO: agentes, conversas e (depois) skills, rules e specs vivem dentro de um, com a sua pasta
 * (`<dados>/projects/<id>/`). ⚖️ Vários projetos isolados no mesmo gateway, cada um com as suas
 * particularidades. Modelos, MCPs e pacotes são do sistema e valem para todos.
 */
/**
 * 🎨 As paletas que um projeto pode usar no lugar do verde do tema (as padrão do Tailwind; a tela tem os valores). Vermelho
 * e amarelo ficam de fora: são as cores de erro e de alerta.
 */
export const PROJECT_COLORS = ['emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'orange', 'lime'] as const
export type TProjectColor = (typeof PROJECT_COLORS)[number]

export interface IProject {
  id: string
  name: string
  description?: string
  /** Os padrões (glob) que a varredura do importador ignora nos repositórios do projeto. O admin define. */
  importIgnore?: string[]
  /** O ambiente agêntico que o importador olha (`Import.Scope`). Ausente: os lugares padrão, todos ligados. O admin define. */
  importScope?: IAgenticScope
  /**
   * As variáveis FIXAS do projeto (o valor é visível): valem no terminal de todo agente nas conversas dele, por BAIXO das
   * do agente. Segredo não mora aqui: vai nas secretas do projeto (`ResourceSecret.Model`). Ausente = nenhuma.
   */
  env?: Record<string, string>
  /**
   * Os valores VISÍVEIS que o projeto dá às variáveis "do projeto" de cada MCP. ⛔ Só para o processo do MCP, nunca para o
   * terminal do agente. Os secretos ficam no cofre (`mcp`). Ausente = nenhum.
   */
  mcpEnv?: IProjectMcpVar[]
  /** 🎨 A cor do destaque da tela neste projeto (uma paleta do Tailwind, ver `PROJECT_COLORS`). Desta máquina: não vai no catálogo. */
  color?: TProjectColor
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** Um valor visível que o projeto dá a uma variável de um MCP (`server` = o id do MCP, como o agente o cita). */
export interface IProjectMcpVar {
  server: string
  name: string
  value: string
}

/** Os tetos das variáveis do projeto. */
export const PROJECT_ENV_LIMITS = { fixed: 50, mcp: 200, value: 4096 } as const

/**
 * ⚖️ O PAPEL NO PROJETO: o administrador do projeto cuida de tudo dele (agentes, catálogo, permissões, membros); o membro
 * conversa com os agentes. Todo projeto tem sempre ao menos um administrador. Não confundir com o administrador do
 * GATEWAY (o papel da conta), que cuida do que não é de projeto nenhum.
 */
export const PROJECT_ROLES = ['admin', 'member'] as const
export type TProjectRole = (typeof PROJECT_ROLES)[number]

export interface IProjectMember {
  projectId: string
  userId: string
  role: TProjectRole
  addedAt: Date
  addedBy?: string
}

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
/** O projeto que a migração cria para o que existia antes dos projetos. */
export const DEFAULT_PROJECT_ID = 'geral'
