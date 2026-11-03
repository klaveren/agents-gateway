import { createHash } from 'node:crypto'
import { IWidening, ruleWidenings, TWideningItem } from './Catalog.Widening'
import { IPermissionRequest, PERMISSION_REQUEST_LIMITS, PERMISSION_REQUEST_TTL_DAYS, TPermissionRequestStatus } from './models/PermissionRequest.Model'
import { cleanRules, IPermissionRule, permissionIssues } from './Permission.Policy'

/**
 * O PEDIDO DE PERMISSÃO DO AGENTE: o que uma troca de regras (acrescentar e tirar) restringe — vale já — e o que amplia —
 * fica pendente até um administrador confirmar na tela.
 *
 * ⚖️ A DEFINIÇÃO DE "AMPLIA" É A DO CATÁLOGO (`Catalog.Widening.ruleWidenings`): as mesmas chaves que o import e o
 * rollback pedem em `confirm`. Restringe: `deny` novo, `allow` tirado. Amplia: `allow` novo, `deny` tirado — menos o que
 * o detector prova que não abre nada (um `allow` já coberto por outro).
 *
 * ⚖️ NA DÚVIDA, TRAVA: as ampliações de um pedido andam juntas. Separar a "que não abre nada" da que abre deixaria
 * passar, sem ninguém ver, a parte que só abre junto com a outra (tirar um `deny` estreito sob um largo que também sai).
 */

export interface IRuleChange {
  add: IPermissionRule[]
  remove: IPermissionRule[]
}

export interface IRuleChangeSplit {
  /** O que vale já: as restrições (e, se nada amplia, a troca inteira). */
  immediate: IRuleChange
  /** O que fica no pedido: as ampliações (vazio = nada a pedir). */
  pending: IRuleChange
  /** As regras do agente depois do que vale já. */
  rules: IPermissionRule[]
  /** As ampliações do pedido, sobre `rules`. */
  widenings: IWidening[]
}

const EMPTY: IRuleChange = { add: [], remove: [] }

/** A mesma regra: categoria, padrão (aparado) e decisão. A nota não conta. */
export function sameRule(a: IPermissionRule, b: IPermissionRule): boolean {
  return a.category === b.category && a.decision === b.decision && a.pattern.trim() === b.pattern.trim()
}

/** As regras depois da troca: tira as de `remove`, acrescenta no fim as de `add` que ainda não estão. */
export function applyRuleChange(rules: readonly IPermissionRule[], change: IRuleChange): IPermissionRule[] {
  const kept = rules.filter((rule) => !change.remove.some((gone) => sameRule(rule, gone)))
  for (const rule of change.add) if (!kept.some((existing) => sameRule(existing, rule))) kept.push(rule)
  return cleanRules(kept)
}

/**
 * O que está errado na troca: cada regra pelo MESMO validador do formulário do agente (`permissionIssues`), o motivo
 * (obrigatório: é o que quem confirma lê), regra a tirar que o agente não tem, e a mesma regra nos dois lados.
 */
export function ruleChangeIssues(input: { add?: unknown; remove?: unknown; reason?: unknown }, current: readonly IPermissionRule[]): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) issues.push({ field: 'reason', message: 'required: why the agent needs this (shown to whoever confirms)' })
  else if (reason.length > PERMISSION_REQUEST_LIMITS.reason) issues.push({ field: 'reason', message: `at most ${PERMISSION_REQUEST_LIMITS.reason} characters` })
  for (const field of ['add', 'remove'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (Array.isArray(value) && value.length > PERMISSION_REQUEST_LIMITS.rules) {
      issues.push({ field, message: `at most ${PERMISSION_REQUEST_LIMITS.rules} rules` })
      continue
    }
    issues.push(...permissionIssues(value).map((issue) => ({ ...issue, field: issue.field.replace(/^permissions/, field) })))
  }
  if (issues.length) return issues
  const add = (input.add as IPermissionRule[] | undefined) ?? []
  const remove = (input.remove as IPermissionRule[] | undefined) ?? []
  if (!add.length && !remove.length) return [{ field: 'add', message: 'send add and/or remove' }]
  remove.forEach((rule, index) => {
    if (!current.some((existing) => sameRule(existing, rule))) issues.push({ field: `remove[${index}]`, message: 'not among the agent rules (see list_permission_rules)' })
  })
  add.forEach((rule, index) => {
    if (remove.some((gone) => sameRule(gone, rule))) issues.push({ field: `add[${index}]`, message: 'the same rule is also in remove' })
  })
  return issues
}

/**
 * Separa a troca (já validada) em o que vale já e o que fica pendente. `item`: o agente (o tipo, o id e o projeto entram
 * nas chaves).
 */
export function splitRuleChange(item: TWideningItem, current: readonly IPermissionRule[], change: IRuleChange): IRuleChangeSplit {
  const restrictions: IRuleChange = { add: change.add.filter((rule) => rule.decision === 'deny'), remove: change.remove.filter((rule) => rule.decision === 'allow') }
  const widening: IRuleChange = { add: change.add.filter((rule) => rule.decision === 'allow'), remove: change.remove.filter((rule) => rule.decision === 'deny') }
  const next = applyRuleChange(current, restrictions)
  // ⛔ A trava do detector: se a "restrição" ampliasse (não amplia, pela regra), nada vale já — vai tudo para o pedido.
  if (ruleWidenings(item, current, next).length) {
    const all = applyRuleChange(current, change)
    return { immediate: EMPTY, pending: change, rules: cleanRules(current), widenings: ruleWidenings(item, current, all) }
  }
  const widenings = ruleWidenings(item, next, applyRuleChange(next, widening))
  if (!widenings.length) return { immediate: change, pending: EMPTY, rules: applyRuleChange(current, change), widenings: [] }
  return { immediate: restrictions, pending: widening, rules: next, widenings }
}

/** O que a aprovação abriria AGORA, sobre as regras do agente de agora (o agente pode ter mudado desde o pedido). */
export function requestWidenings(item: TWideningItem, current: readonly IPermissionRule[], request: Pick<IPermissionRequest, 'add' | 'remove'>): IWidening[] {
  return ruleWidenings(item, current, applyRuleChange(current, request))
}

/** A impressão das regras (sem nota, em ordem): outra na aprovação = o agente mudou desde o pedido. */
export function rulesHash(rules: readonly IPermissionRule[]): string {
  const lines = cleanRules(rules)
    .map((rule) => `${rule.decision}\u0000${rule.category}\u0000${rule.pattern}`)
    .sort()
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/** Quando o pedido vence. */
export function requestExpiresAt(request: Pick<IPermissionRequest, 'createdAt'>, days = PERMISSION_REQUEST_TTL_DAYS): Date {
  return new Date(request.createdAt.getTime() + days * 86_400_000)
}

/** ⚖️ Vencer é calculado na leitura: sem tarefa de fundo, o pendente velho só deixa de ser aprovável. */
export function requestStatus(request: Pick<IPermissionRequest, 'status' | 'createdAt'>, now: Date, days = PERMISSION_REQUEST_TTL_DAYS): TPermissionRequestStatus {
  if (request.status !== 'pending') return request.status
  return now.getTime() >= requestExpiresAt(request, days).getTime() ? 'expired' : 'pending'
}
