import path from 'node:path'

export interface IBashPolicy {
  /** Tempo máximo por comando. */
  timeoutMs: number
  /** Corte do stdout/stderr devolvido ao modelo. */
  maxOutputChars: number
  /** Diretório onde o comando roda. */
  cwd: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_OUTPUT_CHARS = 4_000

/**
 * Padrões que negamos sempre.
 *
 * Não é um sandbox e não pretende ser: é uma trava contra o comando catastrófico
 * digitado por engano — ou alucinado pelo modelo. Contenção de verdade é isolar o
 * processo (container, usuário sem privilégio), não filtrar string.
 */
const DENIED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b[^|;&\n]*-[a-z]*r[a-z]*f|\brm\b[^|;&\n]*-[a-z]*f[a-z]*r/i, reason: 'recursive force delete' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem format' },
  { pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//i, reason: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: 'redirect into a block device' },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: 'fork bomb' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/i, reason: 'pipe from network straight into a shell' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'host power control' },
  { pattern: /\bchmod\b[^|;&\n]*-[a-z]*R[a-z]*\s+777\s+\//i, reason: 'recursive world-writable on a root path' },
  { pattern: /\bsudo\b/i, reason: 'privilege escalation' },
]

export function bashPolicy(): IBashPolicy {
  return {
    timeoutMs: readPositiveInt(process.env.BASH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputChars: readPositiveInt(process.env.BASH_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS),
    cwd: process.env.BASH_CWD ? path.resolve(process.env.BASH_CWD) : process.cwd(),
  }
}

/** Devolve o motivo da recusa, ou `undefined` se o comando passa. */
export function denyReason(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed) return 'empty command'

  const match = DENIED.find((rule) => rule.pattern.test(trimmed))
  return match ? match.reason : undefined
}

export function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  return `${output.substring(0, maxChars)}\n...[truncated at ${maxChars} characters]`
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
