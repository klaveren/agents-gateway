import { existsSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { isSecretPath } from '@domain/Permission.Policy'
import type { TDiagnosticRun } from './Edit.Diagnostics'
import { realOf, resolveInside } from './File.Tools'

/**
 * 🔎 O ESLINT DO EDITOR DA TELA: o do próprio repositório (`node_modules/.bin/eslint` do pacote do arquivo, com a config
 * dele), rodando no MESMO cerco do diagnóstico do agente — a config é código do repositório, e o agente a escreve.
 * ⛔ Sem cerco no servidor, não roda (`unavailable`); nunca `npx` (sem rede).
 */
export interface ILintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: 1 | 2
  message: string
  ruleId?: string
}

export interface ILintResult {
  status: 'ok' | 'ignored' | 'unavailable' | 'failed'
  messages: ILintMessage[]
  reason?: string
}

export const LINT_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const LINT_TIMEOUT_MS = 60_000
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

function nearest(from: string, root: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return dir
    if (dir === root || dirname(dir) === dir || relative(root, dir).startsWith('..')) return undefined
  }
}

/** A saída do `eslint --format json` (com o stderr junto): as mensagens do arquivo. */
export function parseEslintJson(output: string): ILintMessage[] | 'ignored' | undefined {
  const json = output.split('\n').find((line) => line.trimStart().startsWith('['))
  let results: Array<{ messages?: Array<{ line?: number; column?: number; endLine?: number; endColumn?: number; severity?: number; message?: string; ruleId?: string | null }> }>
  try {
    results = JSON.parse(json ?? '')
  } catch {
    return undefined
  }
  const raw = results.flatMap((result) => result.messages ?? [])
  if (raw.length === 1 && !raw[0].ruleId && /ignored/i.test(raw[0].message ?? '')) return 'ignored'
  return raw.map((message) => ({
    line: Math.max(1, message.line ?? 1),
    column: Math.max(1, message.column ?? 1),
    ...(message.endLine ? { endLine: message.endLine } : {}),
    ...(message.endColumn ? { endColumn: message.endColumn } : {}),
    severity: message.severity === 2 ? 2 : 1,
    message: message.message ?? '',
    ...(message.ruleId ? { ruleId: message.ruleId } : {}),
  }))
}

export async function lintRepositoryFile(root: string, path: string, run: TDiagnosticRun | undefined): Promise<ILintResult> {
  if (!LINT_EXT.has(extname(path).toLowerCase())) return { status: 'ignored', messages: [], reason: 'tipo de arquivo sem ESLint' }
  if (isSecretPath(path)) return { status: 'ignored', messages: [] }
  const realRoot = realOf(resolve(root))
  const real = resolveInside(realRoot, path)
  if (!real || !existsSync(real)) return { status: 'failed', messages: [], reason: 'arquivo não encontrado' }
  const pkg = nearest(dirname(real), realRoot, 'package.json') ?? realRoot
  const binDir = nearest(pkg, realRoot, join('node_modules', '.bin', 'eslint'))
  if (!binDir) return { status: 'unavailable', messages: [], reason: 'o repositório não tem eslint no node_modules' }
  if (!run) return { status: 'unavailable', messages: [], reason: 'este servidor não monta o cerco' }
  const out = await run(`${quote(join(binDir, 'node_modules', '.bin', 'eslint'))} --format json ${quote(real)}`, pkg, LINT_TIMEOUT_MS)
  if (out.timedOut) return { status: 'failed', messages: [], reason: 'tempo esgotado' }
  const parsed = parseEslintJson(out.output)
  if (parsed === 'ignored') return { status: 'ignored', messages: [], reason: 'arquivo ignorado pela configuração' }
  if (!parsed) return { status: 'failed', messages: [], reason: out.output.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) }
  return { status: 'ok', messages: parsed }
}
