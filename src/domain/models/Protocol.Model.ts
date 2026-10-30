/**
 * Um PROTOCOLO: como um artefato agêntico (uma skill, um command) deve ser construído neste gateway.
 *
 * ⚖️ O DO CORE nasce no código e chega com a imagem — é o gateway que diz como o ambiente agêntico funciona. Quem
 * administra só SOMA um complemento (global ou do projeto), que vem DEPOIS do core e nunca o substitui: a próxima
 * versão do core continua valendo onde houver complemento.
 */
export type TProtocolKind = 'skill' | 'command' | 'rule' | 'spec' | 'adr' | 'knowledge' | 'agent'
export const PROTOCOL_KINDS: readonly TProtocolKind[] = ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'agent']

export interface ICoreProtocol {
  kind: TProtocolKind
  /** Sobe à mão quando o texto muda: é o que a tela mostra para saber qual está em vigor. */
  version: string
  title: string
  /** Markdown. */
  body: string
}

/** O complemento de quem administra. Ausente o `projectId` = global. */
export interface IProtocolAddendum {
  kind: TProtocolKind
  projectId?: string
  body: string
  updatedAt: Date
  updatedBy?: string
}

/** O protocolo como vale num escopo: o do core e, depois dele, os complementos. */
export interface IProtocolView {
  core: ICoreProtocol
  addenda: { global?: IProtocolAddendum; project?: IProtocolAddendum }
}

/**
 * O rascunho que o construtor entrega (`propose_draft`): ainda não é registro. Os campos valem conforme o tipo — rule:
 * título e corpo; spec/ADR: id, título, resumo e corpo; skill/command: id, descrição, corpo e documentos anexados.
 */
export interface IBuilderDraft {
  kind: TProtocolKind
  id?: string
  title?: string
  summary?: string
  description?: string
  body?: string
  docIds?: string[]
  /** Ausente = o do projeto da conversa (sem projeto, global). */
  global?: boolean
  /** Agente: o registro como o `save_agent` recebe (id, nome, soul, prompt, providers, lanes, ferramentas…). */
  agent?: Record<string, unknown>
  /** Agente: as specs do contexto inicial dele, na ordem. */
  initialContext?: string[]
  /** Agente: as skills e os commands que ele usa (ids, `["*"]` = todos, `[]` = nenhum). Ausente = o padrão (todos). */
  resources?: { skills?: string[]; commands?: string[] }
}
