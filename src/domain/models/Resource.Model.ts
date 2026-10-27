/**
 * Um RECURSO do agente: uma SKILL (um modo de fazer algo, que o agente carrega quando o assunto aparece) ou um
 * COMMAND (um pedido pronto que a pessoa dispara com `/nome argumentos`). Global ou do projeto, como as rules, e com
 * specs e ADRs anexadas, que vão junto quando o recurso é usado.
 *
 * ⚖️ O agente só vê o que a guia Recursos dele libera (ver `IAgentResources`).
 */
export type TResourceKind = 'skill' | 'command'
export const RESOURCE_KINDS: readonly TResourceKind[] = ['skill', 'command']

export interface IResource {
  /** Slug, único no gateway: o nome da skill no índice e o `/nome` do command. */
  id: string
  kind: TResourceKind
  /** Ausente = global. */
  projectId?: string
  /** Uma linha: é o que o agente (e a pessoa, no autocompletar) lê para saber quando usar. */
  description: string
  /** Skill: markdown. Command: o texto que vai ao agente, com `$ARGUMENTS` no lugar do que vem depois do `/nome`. */
  body: string
  /** Specs e ADRs que vão junto, inteiras, quando o recurso é usado. */
  docIds: string[]
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** O que um agente pode usar: ids, ou `['*']` = todos os globais e os do projeto dele. */
export interface IAgentResources {
  skills: string[]
  commands: string[]
}

export const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const RESOURCE_DESCRIPTION_MAX = 300
export const RESOURCE_BODY_MAX = 100_000
export const ALL_RESOURCES = '*'
/** A ferramenta com que o agente carrega uma skill liberada. */
export const USE_SKILL_TOOL = 'use_skill'
