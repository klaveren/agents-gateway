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
  /**
   * ⚠️ Os agentes do projeto que LEEM os `.env` (a única trava do sistema que cede, ver `ISystemRule.opensWith`): o ambiente
   * de desenvolvimento precisa deles para subir a aplicação. Um a um, por id — o agente delegado não herda. Só leitura; os
   * valores são mascarados na conversa. Desta máquina (nunca no catálogo), escolhidos pelo admin do projeto na tela.
   */
  envFileAgents?: string[]
  /**
   * 🖥️ Os AGENTES DE MÁQUINA do projeto: rodam no cerco aberto (tudo o que o usuário do gateway lê e grava, rede livre),
   * com os dados do gateway e os segredos ainda fechados. Só valem com "Permitir agentes de máquina" ligado nas
   * Configurações (`machineAgentsOn`). Desta máquina (nunca no catálogo), escolhidos pelo admin do projeto na tela.
   */
  machineAgents?: string[]
  /** 🔐 Os modelos que o projeto pode usar e os de cada papel ou pessoa (ver `ModelAccess.Policy`). Ausente = tudo do gateway. */
  models?: IProjectModels
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/**
 * 🔐 OS MODELOS DO PROJETO (ver `ModelAccess.Policy`). Cada lista é de `provider/modelo` e AUSENTE = tudo o que vem de cima.
 *  - `allowed`: o que o admin do GATEWAY liberou ao projeto (dentre os ligados no catálogo);
 *  - `byRole` / `byUser`: o que o admin do PROJETO libera a cada papel ou pessoa (a da pessoa vence a do papel), dentro de `allowed`.
 */
export interface IProjectModels {
  allowed?: string[]
  byRole?: Partial<Record<TProjectRole, string[]>>
  byUser?: Record<string, string[]>
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

/** ⚠️ O agente lê os `.env` deste projeto (ver `IProject.envFileAgents`)? */
/** 🖥️ O agente está marcado como de máquina neste projeto (ver `IProject.machineAgents`)? Sozinho não liga nada: falta o sistema. */
export function marksMachine(project: Pick<IProject, 'machineAgents'> | undefined, agentId: string | undefined): boolean {
  return !!agentId && !!project?.machineAgents?.includes(agentId)
}

export function readsEnvFiles(project: Pick<IProject, 'envFileAgents'> | undefined, agentId: string | undefined): boolean {
  return !!agentId && !!project?.envFileAgents?.includes(agentId)
}
