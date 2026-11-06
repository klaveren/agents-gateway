import type { IImportProblem } from './ImportProblem.Model'
import type { IAgentTrigger } from './Agent.Model'
import type { IResourceFile } from './ResourceFile.Model'

/**
 * Um RECURSO do agente: uma SKILL (um modo de fazer algo, que o agente carrega quando o assunto aparece) ou um
 * COMMAND (um pedido pronto que a pessoa dispara com `/nome argumentos`). Global ou do projeto, como as rules, e com
 * specs e ADRs anexadas, que vão junto quando o recurso é usado — inteiras ou, as marcadas, por referência.
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
  /** Specs e ADRs anexadas, na ordem: vão junto quando o recurso é usado. */
  docIds: string[]
  /**
   * Das anexadas, as que vão POR REFERÊNCIA: o recurso carregado lista id, título e tamanho, e o agente as lê com
   * `read_doc` só se precisar. Sempre um subconjunto de `docIds`. ⚖️ Ausente ou vazio = todas inteiras (o de antes):
   * quem decide é a pessoa, anexo a anexo — o sistema não impõe teto de tamanho.
   */
  docRefs?: string[]
  /** Os arquivos da pasta da skill/command (scripts, modelos): ver `ResourceFile.Model`. Ausente = nenhum. */
  files?: IResourceFile[]
  /** Os problemas da importação que ficaram no recurso (ver `ImportProblem.Model`). Ausente = nenhum. */
  importIssues?: IImportProblem[]
  /**
   * Os TRIGGERS do recurso, como os do agente (`IAgentTrigger`): o procedimento de uma situação dentro da skill ou do
   * command. Carregado o recurso, ele lista só id e "quando" de cada um; o corpo entra quando a situação acontece
   * (`use_resource`, tipo trigger, id `<recurso>/<trigger>`). Ausente = nenhum.
   */
  triggers?: IAgentTrigger[]
  /** As tags (ver `Tag.Policy`): para agrupar e filtrar nas listas. Ausente = nenhuma. */
  tags?: string[]
  /**
   * ⛔ Os projetos com que o dono COMPARTILHA o item (ver `Share.Policy`): eles o usam só para leitura; a manutenção é do
   * projeto de origem. Só item de projeto (o global já vale para todos). Ausente = nenhum.
   */
  sharedWith?: string[]
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

/** O que vale para o agente, do que está gravado: sem marcação, todos (`*`); a marca de "nenhum", nenhum (`[]`). */
export function effectiveResources(stored: IAgentResources): IAgentResources {
  const of = (ids: string[]) => (!ids.length ? [ALL_RESOURCES] : ids.filter((id) => id !== NO_RESOURCES))
  return { skills: of(stored.skills), commands: of(stored.commands) }
}
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
