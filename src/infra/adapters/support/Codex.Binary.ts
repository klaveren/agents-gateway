import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** O binário que o `@openai/codex-sdk` usa — o mesmo caminho que ele resolve. */
export function codexBinary(): string {
  const triple = `${process.platform}-${process.arch}`
  const vendor: Record<string, [string, string]> = {
    'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  }
  const target = vendor[triple]
  if (!target) throw new Error(`Codex não tem binário para ${triple}`)
  const codexRequire = createRequire(require.resolve('@openai/codex/package.json'))
  return join(dirname(codexRequire.resolve(`${target[0]}/package.json`)), 'vendor', target[1], 'bin', 'codex')
}

/**
 * ⛔ A VERSÃO TESTADA do Codex. As travas (`CODEX_LOCKED_FEATURES`) desligam recursos POR NOME, verificadas
 * nesta versão: uma versão nova que renomeie o terminal o deixaria ligado. Outra versão recusa, a não ser
 * que `CODEX_ALLOW_UNTESTED=1` diga que alguém conferiu.
 */
export const CODEX_TESTED_VERSION = '0.163.'

let checked: string | undefined

/** `undefined` se a versão é a testada; senão, o motivo da recusa. Lê o binário uma vez por processo. */
export function untestedCodex(
  env: NodeJS.ProcessEnv = process.env,
  read: () => string = () => execFileSync(codexBinary(), ['--version'], { encoding: 'utf8', timeout: 10_000 }),
): string | undefined {
  if (env.CODEX_ALLOW_UNTESTED?.trim() === '1') return undefined
  checked ??= read().trim()
  return checked.includes(` ${CODEX_TESTED_VERSION}`)
    ? undefined
    : `Codex ${checked} is not the tested version (${CODEX_TESTED_VERSION}x): its lock-down is by feature name. Set CODEX_ALLOW_UNTESTED=1 after checking.`
}
