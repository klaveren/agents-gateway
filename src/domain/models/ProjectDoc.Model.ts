/**
 * Um DOCUMENTO de referência em markdown: uma spec (como algo deve ser) ou uma ADR (uma decisão de
 * arquitetura e o porquê). O status de uma ADR ("Proposta", "Aceita"…) fica no próprio texto.
 *
 * ⚖️ O PROMPT LEVA SÓ O ÍNDICE (id, título, resumo): o agente lê o documento inteiro com `read_doc` quando
 * precisa — documento grande não pesa no contexto de toda conversa. Global ou do projeto, como a rule.
 */
export type TDocKind = 'spec' | 'adr'
export const DOC_KINDS: readonly TDocKind[] = ['spec', 'adr']

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
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** A ferramenta com que o agente lê um documento do índice (ver `read_doc` em `Local.Tools`). */
export const READ_DOC_TOOL = 'read_doc'

export const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const DOC_TITLE_MAX = 160
export const DOC_SUMMARY_MAX = 300
export const DOC_BODY_MAX = 200_000
