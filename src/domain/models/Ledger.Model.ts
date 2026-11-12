/**
 * O LEDGER DO AGENTE — o "hipocampo" dele (spec `core-agent-ledger`): o conhecimento durável de COMO AGIR ("de agora em
 * diante, quando X, faço Y"), nunca o estado da sessão ("onde parei").
 *
 * ⚖️ POR AGENTE, não por projeto: é o agente que aprende, e ele leva o que sabe para qualquer conversa.
 * ⚖️ Estrutura LSA: CONTEXTOS (um tema, com o gatilho de UMA linha que diz quando carregá-lo e um playbook opcional) e
 * LINHAS telegráficas dentro de cada contexto. O ÍNDICE (tema → gatilho, nunca o conteúdo) é o que vai no prompt; o
 * contexto o agente carrega sob demanda (`ledger_read`).
 */

/**
 * ⚖️ O LEDGER DO AGENTE GLOBAL NUM PROJETO: o dono é `<agente>@<projeto>` (o `@` não cabe em id de agente nem de projeto).
 * O ledger do agente sem projeto (o de antes) é a BASE: aparece em todo projeto, só para leitura; escrever num tema dela
 * copia o tema para o projeto, que muda lá. O que ele aprende no projeto fica no projeto.
 */
export const LEDGER_PROJECT_SEPARATOR = '@'
export const ledgerOwnerKey = (agentId: string, projectId: string) => `${agentId}${LEDGER_PROJECT_SEPARATOR}${projectId}`
/** O agente do dono (`atlas@bh` → `atlas`) e o projeto (ausente = a base). */
export function parseLedgerOwner(owner: string): { agentId: string; projectId?: string } {
  const at = owner.indexOf(LEDGER_PROJECT_SEPARATOR)
  return at === -1 ? { agentId: owner } : { agentId: owner.slice(0, at), projectId: owner.slice(at + 1) }
}

export const LEDGER_READ_TOOL = 'ledger_read'
export const LEDGER_WRITE_TOOL = 'ledger_write'
export const LEDGER_TOOLS: readonly string[] = [LEDGER_READ_TOOL, LEDGER_WRITE_TOOL]

/**
 * O TIPO da linha (§3 da spec), que calibra o peso dela:
 * - `APRENDIZADO` (ou REGRA): como fazer, verdade VERIFICADA;
 * - `POSTURA` (ou MODO): como AGIR (tom, parceria);
 * - `DIFICULDADE` (ou FALHA): episódio honesto — contexto, NÃO vira regra.
 */
export const LEDGER_LINE_TYPES = ['APRENDIZADO', 'POSTURA', 'DIFICULDADE'] as const
export type TLedgerLineType = (typeof LEDGER_LINE_TYPES)[number]

export const LEDGER_LINE_TYPE_LABEL: Record<TLedgerLineType, string> = {
  APRENDIZADO: 'APRENDIZADO/REGRA',
  POSTURA: 'POSTURA/MODO',
  DIFICULDADE: 'DIFICULDADE/FALHA',
}

/** Quem mexeu: o próprio agente (numa conversa) ou um administrador na tela. É a troca do `git log` das pastas antigas. */
/**
 * Quem escreveu. `via`: a escrita veio de um projeto CONECTADO (o gateway de um dev usando o projeto desta instalação):
 * a conta dona da conexão; a conversa é a de lá, que esta instalação não abre.
 */
export type TLedgerAuthor = { kind: 'agent'; agentId: string; conversationId?: string; via?: string } | { kind: 'admin'; email: string }

export interface ILedgerContext {
  /** Interno: a chave das linhas e das revisões. */
  id: number
  agentId: string
  /** O slug do tema (`build-oom`): único no ledger do agente. */
  topic: string
  /** QUANDO carregar, em uma linha com substância. Sem ele o contexto é inalcançável. */
  trigger: string
  /** O anexo rico (markdown): árvore, diagrama, contrato — o que fatiar em linhas destruiria. Vazio = sem. */
  playbook: string
  createdAt: Date
  createdBy: TLedgerAuthor
  updatedAt: Date
  updatedBy: TLedgerAuthor
}

/** Uma linha: `[DATA] | TIPO | gatilho/contexto | aprendizado em 1 frase | ação/ref`. */
export interface ILedgerLine {
  id: number
  contextId: number
  /** `AAAA-MM-DD`: quando se aprendeu (a migração de um ledger antigo preserva a data original). */
  date: string
  type: TLedgerLineType
  /** Em que situação vale. */
  trigger: string
  /** O aprendizado, em uma frase. */
  learning: string
  /** A ação ou a referência (arquivo, ticket, comando). Vazio = sem. */
  ref: string
  createdAt: Date
  createdBy: TLedgerAuthor
  updatedAt: Date
  updatedBy: TLedgerAuthor
}

/** As ações de escrita (as mesmas do `ledger_write` e da tela). */
export const LEDGER_ACTIONS = ['criar', 'gatilho', 'playbook', 'linha_nova', 'linha_editar', 'linha_apagar', 'excluir'] as const
export type TLedgerAction = (typeof LEDGER_ACTIONS)[number]

/** O retrato de um contexto ou de uma linha numa revisão (antes ou depois). */
export type TLedgerLineSnapshot = { id: number; date: string; type: TLedgerLineType; trigger: string; learning: string; ref: string }
/** O contexto: o gatilho e o playbook (e, na exclusão, as linhas que saíram com ele). */
export type TLedgerContextSnapshot = { trigger: string; playbook: string; lines?: TLedgerLineSnapshot[] }
export type TLedgerSnapshot = TLedgerContextSnapshot | TLedgerLineSnapshot

/**
 * Uma mudança, com quem, quando, antes e depois. ⚖️ Guarda o TEMA, e não só o id do contexto: o histórico de um contexto
 * excluído (ou recriado com o mesmo tema) continua legível.
 */
export interface ILedgerRevision {
  id: number
  agentId: string
  topic: string
  action: TLedgerAction
  lineId?: number
  at: Date
  by: TLedgerAuthor
  before?: TLedgerSnapshot
  after?: TLedgerSnapshot
}

/** Um aviso de saúde, CALCULADO na leitura (nunca gravado). `topic` ausente = do ledger inteiro. */
export interface ILedgerWarning {
  code: 'trigger-missing' | 'trigger-weak' | 'state-verb' | 'too-many-lines' | 'similar-topics' | 'empty-context'
  topic?: string
  /** `similar-topics`: o outro tema do par. */
  related?: string
  lineId?: number
  message: string
}

/** O pedido de escrita, já com nomes do domínio (a ferramenta e a tela traduzem para cá). */
export interface ILedgerWrite {
  action: TLedgerAction
  topic: string
  trigger?: string
  playbook?: string
  lineId?: number
  line?: Partial<Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>>
}

/** Os limites. ⚖️ A meta de saúde (40 linhas) é aviso; os tetos (`max…`) são trava contra abuso. */
export const LEDGER_LIMITS = {
  topicMax: 64,
  triggerMin: 15,
  triggerMax: 240,
  lineTriggerMax: 200,
  learningMax: 300,
  refMax: 240,
  playbookMax: 20_000,
  /** A meta da spec: ledger < ~40 linhas, só aprendizado. */
  healthyLines: 40,
  maxContexts: 200,
  maxLines: 1_000,
  /** O índice no prompt: até tantos contextos e tantos caracteres; o resto, `ledger_read` sem tema. */
  promptContexts: 60,
  promptChars: 4_000,
} as const
