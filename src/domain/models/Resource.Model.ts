/**
 * Um RECURSO do agente: uma SKILL (um modo de fazer algo, que o agente carrega quando o assunto aparece) ou um
 * COMMAND (um pedido pronto que a pessoa dispara com `/nome argumentos`). Global ou do projeto, como as rules, e com
 * specs e ADRs anexadas, que vão junto quando o recurso é usado.
 *
 * ⚖️ Por padrão o agente usa todos os do escopo dele; a guia Recursos restringe (ver `IAgentResources`).
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

/**
 * O que um agente pode usar: ids, ou `['*']` = todos os globais e os do projeto dele. ⚖️ Sem marcação nenhuma, TODOS
 * (o `*`): criar uma skill e ter de liberá-la agente por agente deixava o `/` vazio. "Nenhum" é escolha explícita
 * (`NO_RESOURCES` no banco; `[]` na API).
 */
export interface IAgentResources {
  skills: string[]
  commands: string[]
}

export const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const RESOURCE_DESCRIPTION_MAX = 300
export const ALL_RESOURCES = '*'
/** A marca gravada de "nenhum, de propósito" — sem ela, a lista vazia seria o padrão (todos). */
export const NO_RESOURCES = '-'
/**
 * A ferramenta com que o agente carrega, sob demanda, um recurso que o índice do prompt lista: uma skill liberada, um
 * command liberado ou um trigger dele. ⚖️ Um carregador só; cada tipo segue com os seus dados, a sua tela e a sua regra.
 */
export const USE_RESOURCE_TOOL = 'use_resource'
/** A ferramenta com que um agente cria, edita e apaga triggers (os dele ou os de outro, pela regra `trigger`). */
export const AGENT_TRIGGER_TOOL = 'agent_trigger'
/** A busca por nome e descrição entre os recursos que o agente pode carregar. */
export const SEARCH_RESOURCES_TOOL = 'search_resources'
/** Os tipos que o `use_resource` carrega. */
export const USABLE_KINDS = ['skill', 'command', 'trigger'] as const
export type TUsableKind = (typeof USABLE_KINDS)[number]
