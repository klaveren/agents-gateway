import type { IPermissionChecker } from '@application/Permissions.Service'
import { cercoPlan } from '@domain/Cerco.Plan'
import { DEFAULT_DIAGNOSTICS_SECONDS, diagnosticsOn, IAgentDiagnostics } from '@domain/models/Agent.Model'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { existsSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { networkGate } from '@infra/permissions/Network.Gate'
import { IProjectSandbox, projectSandbox, SANDBOX_SHELL } from '@infra/sandbox/Project.Sandbox'
import { subscriptionEnv } from '@infra/adapters/support/Subscription.Workspace'
import { startCommand } from './Background.Processes'
import { realOf, resolveInside } from './File.Tools'

/** Roda uma linha do GATEWAY (não do modelo) numa pasta. */
export type TDiagnosticRun = (line: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; output: string; timedOut: boolean }>

/** O diagnóstico de uma edição: o texto que vai junto do resultado da ferramenta, ou nada. */
export interface IEditDiagnostics {
  after(file: string, root: string, settings: IAgentDiagnostics | undefined, context: IExecutionContext | undefined): Promise<string | undefined>
}

const PRETTIER_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.css', '.scss', '.less', '.html', '.md', '.yaml', '.yml'])
const ESLINT_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const TSC_EXT = new Set(['.ts', '.tsx', '.mts', '.cts'])
/** O teto de cada ferramenta no texto que volta: o começo (os primeiros problemas) basta para o modelo agir. */
const SECTION_MAX = 1500
const LINES_MAX = 15

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A pasta mais próxima do arquivo, até a raiz, que tem `name`. */
function nearest(from: string, root: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return dir
    if (dir === root || dirname(dir) === dir || relative(root, dir).startsWith('..')) return undefined
  }
}

/**
 * ⚖️ O DIAGNÓSTICO DEPOIS DE EDITAR: o que o pacote do arquivo já usa — o `node_modules/.bin` dele (ou de um pai, até a
 * pasta de trabalho), nunca `npx` (a rede do cerco é fechada) — roda sobre o arquivo editado, e a saída volta filtrada a
 * ele. Ferramenta que o pacote não tem é dita, não baixada.
 */
export async function diagnoseEdit(file: string, root: string, settings: IAgentDiagnostics, run: TDiagnosticRun): Promise<string | undefined> {
  const realRoot = realOf(resolve(root))
  const real = resolveInside(realRoot, file)
  if (!real) return undefined
  const ext = extname(real).toLowerCase()
  const pkg = nearest(dirname(real), realRoot, 'package.json') ?? realRoot
  const bin = (name: string, from: string) => {
    const dir = nearest(from, realRoot, join('node_modules', '.bin', name))
    return dir ? join(dir, 'node_modules', '.bin', name) : undefined
  }
  const timeoutMs = (settings.timeoutSeconds ?? DEFAULT_DIAGNOSTICS_SECONDS) * 1000
  const checks: Array<Promise<string>> = []
  const missing: string[] = []
  if (settings.typecheck && TSC_EXT.has(ext)) {
    const project = nearest(dirname(real), realRoot, 'tsconfig.json')
    const tsc = project && bin('tsc', project)
    if (!project) missing.push('tsc (sem tsconfig.json)')
    else if (!tsc) missing.push('tsc')
    else checks.push(run(`${quote(tsc)} --noEmit --pretty false -p ${quote(project)}`, project, timeoutMs).then((out) => `tsc: ${readTsc(out, real, project)}`))
  }
  if (settings.lint && ESLINT_EXT.has(ext)) {
    const eslint = bin('eslint', pkg)
    if (!eslint) missing.push('eslint')
    else checks.push(run(`${quote(eslint)} --format json ${quote(real)}`, pkg, timeoutMs).then((out) => `eslint: ${readEslint(out)}`))
  }
  if (settings.format && PRETTIER_EXT.has(ext)) {
    const prettier = bin('prettier', pkg)
    if (!prettier) missing.push('prettier')
    else checks.push(run(`${quote(prettier)} --check ${quote(real)}`, pkg, timeoutMs).then((out) => `prettier: ${readPrettier(out, relative(pkg, real))}`))
  }
  if (!checks.length && !missing.length) return undefined
  const lines = await Promise.all(checks)
  if (missing.length) lines.push(`fora do node_modules/.bin do pacote: ${missing.join(', ')}`)
  return `Diagnóstico do gateway depois da edição (${relative(realRoot, real)}):\n${lines.map((line) => `- ${line}`).join('\n')}`
}

type TOutcome = Awaited<ReturnType<TDiagnosticRun>>

const timedOut = (out: TOutcome) => (out.timedOut ? 'tempo esgotado' : undefined)
const clip = (text: string) => (text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX)}…` : text)
const head = (output: string) => clip(output.trim().split('\n').slice(0, LINES_MAX).join('\n'))
const indent = (lines: string[]) => clip(lines.map((line) => `  ${line}`).join('\n'))

/** O tsc: os erros DO arquivo; os dos outros, só contados (a edição pode quebrar quem importa). */
export function readTsc(out: TOutcome, file: string, cwd: string): string {
  if (out.timedOut) return timedOut(out)!
  if (out.code === 0) return 'ok'
  const mine: string[] = []
  let others = 0
  for (const line of out.output.split('\n')) {
    const match = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .*)$/.exec(line.trim())
    if (!match) continue
    if (realOf(resolve(cwd, match[1])) === file) mine.push(`${match[2]}:${match[3]} ${match[5]}`)
    else others += 1
  }
  if (!mine.length && !others) return `falhou (código ${out.code})\n${indent(head(out.output).split('\n'))}`
  const parts = [mine.length ? `${mine.length} erro${mine.length === 1 ? '' : 's'} neste arquivo` : 'ok neste arquivo']
  if (others) parts.push(`${others} em outros arquivos do projeto`)
  return mine.length ? `${parts.join('; ')}\n${indent(mine.slice(0, LINES_MAX))}` : parts.join('; ')
}

/** O eslint (`--format json`): a saída vem com o stderr junto, então o JSON é a linha que começa com `[`. */
export function readEslint(out: TOutcome): string {
  if (out.timedOut) return timedOut(out)!
  const json = out.output.split('\n').find((line) => line.trimStart().startsWith('['))
  let results: Array<{ messages?: Array<{ line?: number; column?: number; severity?: number; message?: string; ruleId?: string | null }> }>
  try {
    results = JSON.parse(json ?? '')
  } catch {
    return out.code === 0 ? 'ok' : `falhou (código ${out.code})\n${indent(head(out.output).split('\n'))}`
  }
  const messages = results.flatMap((result) => result.messages ?? [])
  if (messages.length === 1 && !messages[0].ruleId && /ignored/i.test(messages[0].message ?? '')) return 'arquivo ignorado pela configuração'
  if (!messages.length) return 'ok'
  const errors = messages.filter((message) => message.severity === 2).length
  const summary = [
    errors ? `${errors} erro${errors === 1 ? '' : 's'}` : '',
    messages.length - errors ? `${messages.length - errors} aviso${messages.length - errors === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const lines = messages
    .slice(0, LINES_MAX)
    .map(
      (message) =>
        `${message.line ?? 0}:${message.column ?? 0} ${message.severity === 2 ? 'error' : 'warn'} ${message.message ?? ''}${message.ruleId ? ` (${message.ruleId})` : ''}`,
    )
  return `${summary}\n${indent(lines)}`
}

/** O prettier `--check`: 0 = no padrão; 1 = fora; 2 = não deu para ler (sintaxe, parser). */
export function readPrettier(out: TOutcome, rel: string): string {
  if (out.timedOut) return timedOut(out)!
  if (out.code === 0) return 'ok'
  if (out.code === 1) return `fora do padrão (rode prettier --write ${rel})`
  return `falhou (código ${out.code})\n${indent(head(out.output).split('\n'))}`
}

/**
 * ⛔ O diagnóstico roda no MESMO cerco do `run_bash`, montado das regras do agente: ler e gravar só o que elas liberam,
 * e rede nenhuma (o portão recusa tudo). A linha é do gateway — por isso não passa pela regra `terminal`, que é sobre o
 * que o MODELO pede. Sem cerco no servidor, não roda.
 */
export function makeEditDiagnostics(deps: { permissions?: IPermissionChecker; sandbox?: IProjectSandbox; run?: TDiagnosticRun } = {}): IEditDiagnostics {
  const sandbox = deps.sandbox ?? projectSandbox()
  return {
    async after(file, root, settings, context) {
      if (!diagnosticsOn(settings)) return undefined
      const run = deps.run ?? (deps.permissions && sandbox.wrapWith ? cercado(deps.permissions, sandbox, root, context) : undefined)
      if (!run) return 'Diagnóstico do gateway: não roda — este servidor não monta o cerco das permissões.'
      try {
        return await diagnoseEdit(file, root, settings, run)
      } catch (error: unknown) {
        return `Diagnóstico do gateway falhou: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

function cercado(permissions: IPermissionChecker, sandbox: IProjectSandbox, root: string, context: IExecutionContext | undefined): TDiagnosticRun {
  const projectId = context?.conversationProjectId ?? context?.projectId
  const asker = { ...(context?.agentId ? { agentId: context.agentId } : {}), ...(projectId ? { projectId } : {}), ...(context?.sessionId ? { sessionId: context.sessionId } : {}) }
  const folder = context?.workFolder
  const place = folder ? { scratchBase: realOf(folder.projectDir), ...(folder.gitCommonDir ? { gitCommonDir: realOf(folder.gitCommonDir) } : {}) } : {}
  const { system, ...layers } = permissions.layers?.(asker) ?? { system: [] }
  const realRoot = realOf(resolve(root))
  return async (line, cwd, timeoutMs) => {
    const gate = networkGate()
    const token = gate.register(() => ({ allowed: false, reason: 'o diagnóstico depois da edição roda sem rede' }))
    try {
      const wrapped = await sandbox.wrapWith!(line, realRoot, (base) => cercoPlan(layers, { ...base, system }), token, place)
      return await startCommand(wrapped, { cwd, env: subscriptionEnv({ HOME: realRoot }), shell: SANDBOX_SHELL, timeoutMs }).done
    } finally {
      gate.release(token)
    }
  }
}
