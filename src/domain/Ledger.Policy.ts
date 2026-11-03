import {
  ILedgerContext,
  ILedgerLine,
  ILedgerWarning,
  LEDGER_LIMITS,
  LEDGER_LINE_TYPE_LABEL,
  LEDGER_LINE_TYPES,
  LEDGER_READ_TOOL,
  LEDGER_WRITE_TOOL,
  TLedgerAuthor,
  TLedgerLineType,
} from './models/Ledger.Model'

type TIssues = Array<{ field: string; message: string }>

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TOPIC_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Sem acento e minúsculo: a comparação de tema e a busca não dependem de como a pessoa digitou. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** O tema como slug: "Build OOM" → `build-oom`. ⚖️ Normaliza em vez de recusar — o agente acerta de primeira. */
export function topicSlug(raw: string): string {
  return foldText(raw.trim())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LEDGER_LIMITS.topicMax)
    .replace(/-+$/g, '')
}

/** Os problemas do tema já normalizado. */
export function topicIssues(topic: string): TIssues {
  if (topic.length < 2 || !TOPIC_PATTERN.test(topic)) return [{ field: 'topic', message: 'use 2–64 letters, digits or hyphens (e.g. build-oom)' }]
  return []
}

/** `REGRA` → APRENDIZADO, `MODO` → POSTURA, `FALHA` → DIFICULDADE (a spec usa os dois nomes de cada tipo). */
export function lineTypeOf(raw: unknown): TLedgerLineType | undefined {
  if (typeof raw !== 'string') return undefined
  const value = foldText(raw.trim()).toUpperCase()
  const alias: Record<string, TLedgerLineType> = { REGRA: 'APRENDIZADO', MODO: 'POSTURA', FALHA: 'DIFICULDADE' }
  const head = value.split('/')[0]
  return (LEDGER_LINE_TYPES as readonly string[]).includes(head) ? (head as TLedgerLineType) : alias[head]
}

/** Um campo de UMA linha: obrigatório (ou não), sem quebra, até `max`. */
function oneLine(field: string, value: string | undefined, max: number, required: boolean, issues: TIssues): void {
  const text = value?.trim() ?? ''
  if (!text) {
    if (required) issues.push({ field, message: 'required' })
    return
  }
  if (/[\r\n]/.test(text)) issues.push({ field, message: 'must be a single line' })
  if (text.length > max) issues.push({ field, message: `at most ${max} characters` })
}

/**
 * ⛔ O GATILHO é o que torna o contexto alcançável: obrigatório, uma linha, com substância (≥ 15 caracteres). O gatilho
 * curto ou vago não é recusado acima disso — vira aviso de saúde (`ledgerWarnings`).
 */
export function triggerIssues(trigger: string | undefined): TIssues {
  const issues: TIssues = []
  oneLine('trigger', trigger, LEDGER_LIMITS.triggerMax, true, issues)
  const text = trigger?.trim() ?? ''
  if (text && text.length < LEDGER_LIMITS.triggerMin)
    issues.push({ field: 'trigger', message: `too short: say WHEN to load it, in at least ${LEDGER_LIMITS.triggerMin} characters` })
  return issues
}

export function playbookIssues(playbook: string | undefined): TIssues {
  return (playbook ?? '').length > LEDGER_LIMITS.playbookMax ? [{ field: 'playbook', message: `at most ${LEDGER_LIMITS.playbookMax} characters` }] : []
}

/** Os problemas de uma linha inteira (`partial`: a edição, que só confere o que veio). */
export function lineIssues(line: Partial<Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>>, partial = false): TIssues {
  const issues: TIssues = []
  if (!partial || line.type !== undefined) {
    if (!line.type || !(LEDGER_LINE_TYPES as readonly string[]).includes(line.type)) issues.push({ field: 'type', message: `one of ${LEDGER_LINE_TYPES.join(', ')}` })
  }
  if (!partial || line.trigger !== undefined) oneLine('lineTrigger', line.trigger, LEDGER_LIMITS.lineTriggerMax, true, issues)
  if (!partial || line.learning !== undefined) oneLine('learning', line.learning, LEDGER_LIMITS.learningMax, true, issues)
  if (line.ref !== undefined) oneLine('ref', line.ref, LEDGER_LIMITS.refMax, false, issues)
  if (line.date !== undefined && (!DATE_PATTERN.test(line.date) || Number.isNaN(Date.parse(`${line.date}T00:00:00Z`)))) issues.push({ field: 'date', message: 'use YYYY-MM-DD' })
  return issues
}

/** ⚠️ Os verbos de ESTADO DE MISSÃO (§6, o teste do verbo): o que diz onde parei, e não como agir, não é ledger. */
const STATE_VERBS = /\b(retomar|retome|proximo passo|proximos passos|pendente|pendentes|aguarda|aguardando|aguardar)\b/

export function stateVerbOf(text: string): string | undefined {
  return STATE_VERBS.exec(foldText(text))?.[1]
}

/** O tema "espremido": sem hífen e sem o plural do fim — `build-ooms` e `buildoom` são o mesmo. */
const squash = (topic: string) => topic.replace(/-/g, '').replace(/s$/, '')

/** Dois temas que parecem o mesmo: um é prefixo do outro (por palavra) ou são iguais espremidos. */
export function similarTopics(a: string, b: string): boolean {
  if (a === b) return false
  return a.startsWith(`${b}-`) || b.startsWith(`${a}-`) || squash(a) === squash(b)
}

export interface ILedgerHealthInput {
  contexts: ReadonlyArray<Pick<ILedgerContext, 'topic' | 'trigger' | 'playbook'>>
  lines: ReadonlyArray<Pick<ILedgerLine, 'id' | 'trigger' | 'learning'> & { topic: string }>
}

/**
 * OS AVISOS DE SAÚDE (calculados, nunca gravados): gatilho ausente ou fraco (contexto inalcançável), verbo de estado
 * (missão, não ledger), mais de ~40 linhas (vira bíblia), temas parecidos (conflito nascendo) e contexto vazio.
 */
export function ledgerWarnings(input: ILedgerHealthInput): ILedgerWarning[] {
  const warnings: ILedgerWarning[] = []
  const counts = new Map<string, number>()
  for (const line of input.lines) counts.set(line.topic, (counts.get(line.topic) ?? 0) + 1)
  for (const context of input.contexts) {
    const trigger = context.trigger.trim()
    if (trigger.length < LEDGER_LIMITS.triggerMin)
      warnings.push({ code: 'trigger-missing', topic: context.topic, message: `${context.topic}: sem gatilho de verdade — o contexto é inalcançável` })
    else if (trigger.split(/\s+/).length < 4)
      warnings.push({ code: 'trigger-weak', topic: context.topic, message: `${context.topic}: gatilho fraco (menos de 4 palavras) — diga a situação que dispara` })
    const verb = stateVerbOf(trigger)
    if (verb) warnings.push({ code: 'state-verb', topic: context.topic, message: `${context.topic}: o gatilho tem "${verb}" — estado de missão, não ledger` })
    if (!counts.get(context.topic) && !context.playbook.trim())
      warnings.push({ code: 'empty-context', topic: context.topic, message: `${context.topic}: contexto vazio (sem linhas nem playbook)` })
  }
  for (const line of input.lines) {
    const verb = stateVerbOf(`${line.trigger} ${line.learning}`)
    if (verb)
      warnings.push({ code: 'state-verb', topic: line.topic, lineId: line.id, message: `${line.topic} #${line.id}: "${verb}" — estado de missão (onde parei), não como agir` })
  }
  if (input.lines.length > LEDGER_LIMITS.healthyLines)
    warnings.push({
      code: 'too-many-lines',
      message: `${input.lines.length} linhas (meta: < ${LEDGER_LIMITS.healthyLines}) — pode o "fiz", funda duplicatas, tire o defasado`,
    })
  const topics = input.contexts.map((context) => context.topic).sort()
  for (let i = 0; i < topics.length; i++)
    for (let j = i + 1; j < topics.length; j++)
      if (similarTopics(topics[i], topics[j]))
        warnings.push({ code: 'similar-topics', topic: topics[i], related: topics[j], message: `temas parecidos: ${topics[i]} e ${topics[j]} — mesmo tema? funda num só` })
  return warnings
}

/** A regra de leitura e escrita (o READ-GATE da spec), igual no prompt e na descrição da ferramenta. */
export const LEDGER_GATE = `Antes de diagnosticar, operar ou de tarefa recorrente: confira o índice; casou → \`${LEDGER_READ_TOOL}\` do tema. Aprendeu algo durável → \`${LEDGER_WRITE_TOOL}\` na hora.`

/**
 * A seção do system prompt: SÓ o índice do agente (tema → gatilho, nunca o conteúdo) e a regra. `undefined` sem contexto.
 * ⚖️ Com TETO (60 contextos / ~4 KB): passou, ficam os mais recentes, e o rabo diz como ver o resto — o índice não
 * cresce sem fim no prompt de toda conversa.
 */
export function ledgerPromptSection(contexts: ReadonlyArray<Pick<ILedgerContext, 'topic' | 'trigger' | 'updatedAt'>>): string | undefined {
  if (!contexts.length) return undefined
  const head = ['## Ledger — o que você já aprendeu', LEDGER_GATE]
  const recent = [...contexts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const chosen: typeof recent = []
  let size = head.join('\n').length
  for (const context of recent) {
    const line = `- ${context.topic} — ${context.trigger}`
    if (chosen.length >= LEDGER_LIMITS.promptContexts || size + line.length + 1 > LEDGER_LIMITS.promptChars) break
    chosen.push(context)
    size += line.length + 1
  }
  const rest = contexts.length - chosen.length
  const lines = [...chosen].sort((a, b) => a.topic.localeCompare(b.topic)).map((context) => `- ${context.topic} — ${context.trigger}`)
  return [...head, ...lines, ...(rest ? [`- …${rest} mais: \`${LEDGER_READ_TOOL}\` sem tema.`] : [])].join('\n')
}

/** A linha como a spec a escreve: `[DATA] | TIPO | gatilho | aprendizado | ref`. */
export function lineText(line: Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>): string {
  return [`[${line.date}]`, LEDGER_LINE_TYPE_LABEL[line.type], line.trigger, line.learning, ...(line.ref ? [line.ref] : [])].join(' | ')
}

export function authorLabel(author: TLedgerAuthor): string {
  return author.kind === 'admin' ? author.email : `${author.agentId}${author.conversationId ? ` (conversa ${author.conversationId})` : ''}`
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export interface ILedgerExportContext {
  context: Pick<ILedgerContext, 'topic' | 'trigger' | 'playbook' | 'updatedAt' | 'updatedBy'>
  lines: ReadonlyArray<Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>>
}

/**
 * O EXPORT no formato das pastas antigas: `<agente>-ledger/index.md` (o mapa de gatilhos) e `contextos/<tema>.md`, com o
 * `@trigger` no `[AKM-STAMP]` — o que o `build-ledger-index.mjs` lê. ⚖️ Caminho → conteúdo; quem empacota é a borda.
 */
export function ledgerExportFiles(agentId: string, contexts: readonly ILedgerExportContext[]): Record<string, string> {
  const root = `${agentId}-ledger`
  const sorted = [...contexts].sort((a, b) => a.context.topic.localeCompare(b.context.topic))
  const index = [
    `# Ledger — ${agentId}`,
    '',
    '| contexto | QUANDO carregar | artefato |',
    '| --- | --- | --- |',
    ...sorted.map(({ context }) => `| ${context.topic} | ${cell(context.trigger)} | [contextos/${context.topic}.md](contextos/${context.topic}.md) |`),
    '',
  ].join('\n')
  const files: Record<string, string> = { [`${root}/index.md`]: index }
  for (const { context, lines } of sorted) {
    const body = [
      '<!--',
      '# [AKM-STAMP]',
      `# @artifact    ${context.topic}`,
      `# @trigger     ${context.trigger.replace(/\s+/g, ' ').trim()}`,
      `# @last_audit  ${context.updatedAt.toISOString().slice(0, 10)}`,
      `# @modifier    ${authorLabel(context.updatedBy)}`,
      '-->',
      '',
      `# ${context.topic}`,
      '',
      '`[DATA] | TIPO | gatilho/contexto | aprendizado | ação/ref`',
      '',
      ...(lines.length ? lines.map((line) => `- ${lineText(line)}`) : ['_(sem linhas)_']),
      ...(context.playbook.trim() ? ['', '## Playbook', '', context.playbook.trim()] : []),
      '',
    ].join('\n')
    files[`${root}/contextos/${context.topic}.md`] = body
  }
  return files
}
