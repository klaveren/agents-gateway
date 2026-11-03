import type { ILedgerContextDetail, ILedgerContextSummary, ILedgerIndex, ILedgerReader, LedgerService } from '@application/Ledger.Service'
import { InvalidLedgerError, LedgerNotFoundError } from '@domain/errors/Domain.Error'
import { authorLabel, lineText } from '@domain/Ledger.Policy'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { ILedgerWarning, LEDGER_ACTIONS, LEDGER_LINE_TYPES, LEDGER_READ_TOOL, LEDGER_WRITE_TOOL, TLedgerAction } from '@domain/models/Ledger.Model'
import { ILocalTool, IToolResult } from './Tool.Types'

/** O que as ferramentas usam do serviço (o `LedgerService`). */
export type TLedgerDesk = Pick<LedgerService, 'index' | 'context' | 'search' | 'write' | 'canRead' | 'requireAgent'>

/** O nome do campo da regra → o do argumento da ferramenta (a mensagem fala a língua de quem chamou). */
const ARGUMENT: Record<string, string> = {
  topic: 'tema',
  trigger: 'gatilho',
  playbook: 'playbook',
  type: 'tipo',
  lineTrigger: 'situacao',
  learning: 'aprendizado',
  ref: 'ref',
  date: 'data',
  line: 'linha',
}

const day = (date: Date) => date.toISOString().slice(0, 10)
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

function warningsText(warnings: readonly ILedgerWarning[]): string[] {
  return warnings.length ? ['', 'Saúde:', ...warnings.map((warning) => `- ⚠️ ${warning.message}`)] : []
}

function summaryLine(context: ILedgerContextSummary): string {
  const extras = [`${context.lineCount} linha${context.lineCount === 1 ? '' : 's'}`, ...(context.hasPlaybook ? ['playbook'] : []), `atualizado ${day(context.updatedAt)}`]
  return `- ${context.topic} — ${context.trigger} (${extras.join(', ')})`
}

function indexText(index: ILedgerIndex, owner: string, readOnly: boolean): string {
  const title = `Ledger de ${owner}${readOnly ? ' (somente leitura)' : ''}`
  if (!index.contexts.length) return readOnly ? `${title}: vazio.` : `${title}: vazio. Aprendeu algo durável? ${LEDGER_WRITE_TOOL} { acao: "criar", tema, gatilho }.`
  return [
    `${title} — ${index.contexts.length} contexto(s), ${index.lineCount} linha(s). Abra um com ${LEDGER_READ_TOOL} { tema }.`,
    ...index.contexts.map(summaryLine),
    ...warningsText(index.warnings),
  ].join('\n')
}

function contextText(context: ILedgerContextDetail, owner: string, readOnly: boolean, warnings: readonly ILedgerWarning[] = context.warnings): string {
  return [
    `# ${context.topic}${readOnly ? ` (ledger de ${owner}, somente leitura)` : ''}`,
    `Gatilho: ${context.trigger}`,
    `Atualizado: ${day(context.updatedAt)} por ${authorLabel(context.updatedBy)}`,
    '',
    context.lines.length ? 'Linhas (#id [DATA] | TIPO | situação | aprendizado | ref):' : 'Sem linhas.',
    ...context.lines.map((line) => `#${line.id} ${lineText(line)}`),
    ...(context.playbook ? ['', '## Playbook', context.playbook] : []),
    ...warningsText(warnings),
  ].join('\n')
}

/** O erro da regra vira resultado de ferramenta com os campos pelo nome do argumento. */
function failure(error: unknown): IToolResult {
  if (error instanceof InvalidLedgerError)
    return { status: 'error', result: `Não gravado: ${error.issues.map((issue) => `${ARGUMENT[issue.field] ?? issue.field}: ${issue.message}`).join('; ')}` }
  if (error instanceof LedgerNotFoundError) return { status: 'error', result: error.message }
  return { status: 'error', result: error instanceof Error ? error.message : String(error) }
}

/** ⛔ Quem chama é o agente DO TURNO (o servidor monta o contexto). Sem ele, não há dono: a ferramenta recusa. */
function readerOf(context: IExecutionContext | undefined): ILedgerReader | undefined {
  if (!context?.agentId) return undefined
  const projectId = context.conversationProjectId ?? context.projectId
  return { agentId: context.agentId, ...(projectId ? { conversationProjectId: projectId } : {}) }
}

const NO_AGENT: IToolResult = { status: 'error', result: 'O ledger só funciona na conversa de um agente.' }

/**
 * As DUAS ferramentas do ledger (ver `Ledger.Model`), ligadas a todo agente (ver `AgentProvider.withDocs`).
 *
 * ⛔ O DONO É O AGENTE DO TURNO (`context.agentId`, que o servidor põe), nunca um argumento: o `ledger_write` não tem
 * campo de agente, e quem tenta mandar um (`agente`, `agentId`) de outro leva recusa. O `ledger_read { agente }` lê o de
 * outro agente que ele enxerga (`canRead`), só leitura.
 */
export function makeLedgerTools(desk: TLedgerDesk): ILocalTool[] {
  const read: ILocalTool = {
    origin: 'local',
    name: LEDGER_READ_TOOL,
    description:
      'Your ledger: the durable knowledge of HOW TO ACT you collected (contexts by theme, each with a trigger saying when to load it, telegraphic lines and an optional playbook). No arguments = your index with health warnings; `tema` = that context in full (trigger, lines with ids, playbook); `busca` = the lines and contexts matching the words; `agente` = read another agent ledger (read-only; only agents you can see).',
    inputSchema: {
      type: 'object',
      properties: {
        tema: { type: 'string', description: 'The context theme (slug), from the index.' },
        busca: { type: 'string', description: 'Words to find in the lines, triggers and playbooks.' },
        agente: { type: 'string', description: 'Another agent id: read its ledger instead of yours (read-only).' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, context) {
      const reader = readerOf(context)
      if (!reader) return NO_AGENT
      const target = str(args.agente)?.trim() || reader.agentId
      const readOnly = target !== reader.agentId
      // ⛔ Outro agente: só o que quem chama enxerga; fora disso, como se não existisse.
      if (readOnly && !desk.canRead(reader, target)) return { status: 'error', result: `Agent not found: ${target}` }
      try {
        desk.requireAgent(target)
        const topic = str(args.tema)?.trim()
        const query = str(args.busca)?.trim()
        if (query) {
          const found = desk.search(target, query)
          const lines = topic ? found.lines.filter((line) => line.topic === topic) : found.lines
          const contexts = topic ? found.contexts.filter((item) => item.topic === topic) : found.contexts
          if (!lines.length && !contexts.length) return { status: 'success', result: `Nada no ledger de ${target} para "${query}".` }
          return {
            status: 'success',
            result: [
              `Busca "${query}" no ledger de ${target}${readOnly ? ' (somente leitura)' : ''}:`,
              ...(contexts.length ? ['Contextos:', ...contexts.map(summaryLine)] : []),
              ...(lines.length ? ['Linhas:', ...lines.map((line) => `- ${line.topic} #${line.id} ${lineText(line)}`)] : []),
            ].join('\n'),
          }
        }
        if (topic) return { status: 'success', result: contextText(desk.context(target, topic), target, readOnly) }
        return { status: 'success', result: indexText(desk.index(target), target, readOnly) }
      } catch (error: unknown) {
        return failure(error)
      }
    },
  }

  const write: ILocalTool = {
    origin: 'local',
    name: LEDGER_WRITE_TOOL,
    description:
      'Change YOUR ledger (only yours). Write right away when you learn something durable — how to act from now on ("when X, I do Y"), a recurring root cause, a fix that really worked, a convention you were taught — never session state (where you stopped, next steps, pending). One line = one learning in one sentence; an existing line about it? edit it, do not stack; check the index before creating a theme. Wrong data is worse than none: fix or delete it on the spot. acao: criar (tema + gatilho [+ playbook]); gatilho (new trigger); playbook (set the markdown appendix; empty clears); linha_nova (tipo, situacao, aprendizado [, ref, data]); linha_editar (linha = the id, plus the fields to change); linha_apagar (linha); excluir (the whole context and its lines).',
    inputSchema: {
      type: 'object',
      properties: {
        tema: { type: 'string', description: 'The context theme, as a slug (e.g. build-oom).' },
        acao: { type: 'string', enum: [...LEDGER_ACTIONS], description: 'What to do.' },
        gatilho: { type: 'string', description: 'criar/gatilho: ONE line saying WHEN to load this context (the situation that triggers it), at least 15 characters.' },
        playbook: { type: 'string', description: 'criar/playbook: the rich appendix (markdown): structure, diagram, contract.' },
        linha: { type: 'number', description: 'linha_editar/linha_apagar: the line id (#id in ledger_read).' },
        tipo: {
          type: 'string',
          enum: [...LEDGER_LINE_TYPES],
          description: 'APRENDIZADO = verified how-to/rule; POSTURA = how to act (tone, mode); DIFICULDADE = an honest episode or failure, NOT a rule.',
        },
        situacao: { type: 'string', description: 'The trigger/context of the line: when it applies (one line).' },
        aprendizado: { type: 'string', description: 'The learning, in one sentence (≤ 300 characters).' },
        ref: { type: 'string', description: 'Optional: the action or reference (file, command, ticket).' },
        data: { type: 'string', description: 'Optional YYYY-MM-DD: when it was learned (default today; keep the original when migrating).' },
      },
      required: ['tema', 'acao'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const reader = readerOf(context)
      if (!reader) return NO_AGENT
      // ⛔ Escrever é só no próprio ledger: o agente que vem em argumento (de outro) é recusado, nunca obedecido.
      const claimed = str(args.agente) ?? str(args.agentId)
      if (claimed && claimed.trim() !== reader.agentId)
        return { status: 'error', result: `⛔ Você só escreve no SEU ledger (${reader.agentId}); o de ${claimed} é só leitura (${LEDGER_READ_TOOL} { agente }).` }
      const action = str(args.acao) as TLedgerAction | undefined
      if (!action || !(LEDGER_ACTIONS as readonly string[]).includes(action)) return { status: 'error', result: `acao: uma de ${LEDGER_ACTIONS.join(', ')}` }
      const line = {
        ...(args.tipo !== undefined ? { type: String(args.tipo) as never } : {}),
        ...(args.situacao !== undefined ? { trigger: String(args.situacao) } : {}),
        ...(args.aprendizado !== undefined ? { learning: String(args.aprendizado) } : {}),
        ...(args.ref !== undefined ? { ref: String(args.ref) } : {}),
        ...(args.data !== undefined ? { date: String(args.data) } : {}),
      }
      const lineId =
        typeof args.linha === 'number'
          ? args.linha
          : typeof args.linha === 'string' && /^\d+$/.test(args.linha.replace(/^#/, ''))
            ? Number(args.linha.replace(/^#/, ''))
            : undefined
      try {
        const result = desk.write(
          reader.agentId,
          {
            action,
            topic: str(args.tema) ?? '',
            ...(args.gatilho !== undefined ? { trigger: String(args.gatilho) } : {}),
            ...(args.playbook !== undefined ? { playbook: String(args.playbook) } : {}),
            ...(lineId !== undefined ? { lineId } : {}),
            line,
          },
          { kind: 'agent', agentId: reader.agentId, ...(context?.sessionId ? { conversationId: context.sessionId } : {}) },
        )
        const head = result.changed ? `Gravado: ${action} em ${result.topic}.` : `Nada mudou em ${result.topic} (já estava assim).`
        const body = result.context
          ? contextText(result.context, reader.agentId, false, result.warnings)
          : [`Contexto ${result.topic} excluído.`, ...warningsText(result.warnings)].join('\n')
        return { status: 'success', result: [head, '', body].join('\n') }
      } catch (error: unknown) {
        return failure(error)
      }
    },
  }

  return [read, write]
}
