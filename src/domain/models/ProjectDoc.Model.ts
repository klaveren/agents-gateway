/**
 * Um DOCUMENTO de referência em markdown: uma spec (como algo deve ser), uma ADR (uma decisão de arquitetura e o
 * porquê) ou CONHECIMENTO (o estudo de um tema, com as fontes — a base sólida antes de escrever spec, skill ou ADR). O
 * status de uma ADR ("Proposta", "Aceita"…) fica no próprio texto.
 *
 * ⚖️ O PROMPT LEVA SÓ O ÍNDICE (id, título, resumo): o agente lê o documento inteiro com `read_doc` quando
 * precisa — documento grande não pesa no contexto de toda conversa. Global ou do projeto, como a rule.
 */
export type TDocKind = 'spec' | 'adr' | 'knowledge'
export const DOC_KINDS: readonly TDocKind[] = ['spec', 'adr', 'knowledge']

export interface IProjectDoc {
  /** Slug, único no gateway: é o que o agente passa ao `read_doc`. */
  id: string
  kind: TDocKind
  /** Ausente = global. */
  projectId?: string
  title: string
  /** Uma linha: vai no índice do prompt. */
  summary: string
  /** Markdown. */
  body: string
  /**
   * Outros documentos ANEXADOS a este, na ordem (spec que cita spec, ADR que aponta a spec): vão junto quando este é
   * lido — no `read_doc`, no contexto inicial, no anexo de um recurso. ⛔ Global ou do mesmo projeto deste (o global só
   * anexa global). É o relacionamento entre documentos: feito no painel, nunca por caminho citado no texto.
   * Ausente = nenhum.
   */
  docIds?: string[]
  /**
   * Dos anexados, os que vão POR REFERÊNCIA (id, título, tamanho e resumo; o agente lê com `read_doc` se precisar).
   * Sempre um subconjunto de `docIds`. Ausente ou vazio = todos inteiros — a mesma semântica de `IResource.docRefs`.
   */
  docRefs?: string[]
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** A ferramenta com que o agente lê um documento do índice (ver `read_doc` em `Local.Tools`). */
export const READ_DOC_TOOL = 'read_doc'
/** A ferramenta com que o agente BUSCA nos documentos pelo texto (não só pelo título do índice). */
export const SEARCH_DOCS_TOOL = 'search_docs'
/**
 * Acima disto o índice do prompt lista só os mais recentes e manda buscar o resto: com centenas de documentos, uma linha
 * por documento pesaria em toda conversa.
 */
export const DOC_INDEX_LIMIT = 30

export const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const DOC_TITLE_MAX = 160
export const DOC_SUMMARY_MAX = 300
