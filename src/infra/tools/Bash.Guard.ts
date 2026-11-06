import { liveLimit } from '@domain/models/Limits.Model'
import path from 'node:path'

export interface IBashPolicy {
  /** Tempo máximo por comando. */
  timeoutMs: number
  /** Corte do stdout/stderr devolvido ao modelo. */
  maxOutputChars: number
  /** Diretório onde o comando roda. */
  cwd: string
}

const DEFAULT_TIMEOUT_MS = 120_000
/** O motivo do `sudo` (ver `remoteSudoAllowed`: dentro do `ssh`, com regra que o cite, passa). */
export const PRIVILEGE_ESCALATION = 'privilege escalation'
/** O motivo de desligar ou reiniciar a máquina. Como o sudo, decidido pelos comandos que rodam (ver `realReasons`). */
export const HOST_POWER = 'host power control'
const DEFAULT_MAX_OUTPUT_CHARS = 4_000

/**
 * Padrões que negamos sempre.
 *
 * Não é um sandbox e não pretende ser: é uma trava contra o comando catastrófico
 * digitado por engano — ou alucinado pelo modelo. Contenção de verdade é isolar o
 * processo (container, usuário sem privilégio), não filtrar string.
 */
const DENIED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // ⚖️ Só as OPÇÕES do `rm` (`-rf`, `-r -f`, `--recursive --force`), nunca o texto do caminho: "-surf" em
  // `mcp-tool-surface.md` casava e recusava um `git rm` inocente.
  {
    pattern: /\brm\b(?=[^|;&\n]*\s(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$))(?=[^|;&\n]*\s(?:-[a-z]*f[a-z]*|--force)(?=\s|$))/i,
    reason: 'recursive force delete',
  },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem format' },
  { pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//i, reason: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: 'redirect into a block device' },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: 'fork bomb' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/i, reason: 'pipe from network straight into a shell' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: HOST_POWER },
  { pattern: /\bchmod\b[^|;&\n]*-[a-z]*R[a-z]*\s+777\s+\//i, reason: 'recursive world-writable on a root path' },
  { pattern: /\bsudo\b/i, reason: PRIVILEGE_ESCALATION },
]

export function bashPolicy(): IBashPolicy {
  return {
    timeoutMs: liveLimit('bashTimeoutMs') ?? readPositiveInt(process.env.BASH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputChars: liveLimit('bashMaxOutputChars') ?? readPositiveInt(process.env.BASH_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS),
    // ⛔ Sem `BASH_CWD`, o diretório vazio da conversa (ver `run_bash`) — nunca a pasta do gateway.
    cwd: process.env.BASH_CWD ? path.resolve(process.env.BASH_CWD) : '',
  }
}

/** Devolve o motivo da recusa, ou `undefined` se o comando passa. */
export function denyReason(command: string): string | undefined {
  return deniedReasons(command)[0]
}

/** Todos os motivos que o TEXTO do comando casa, na ordem da lista. */
export function deniedReasons(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return ['empty command']
  return DENIED.filter((rule) => rule.pattern.test(trimmed)).map((rule) => rule.reason)
}

/** Os motivos que o texto acusa mas só valem se o COMANDO roda (o sudo, o reboot): a palavra num grep ou num texto não conta. */
export const COMMAND_REASONS: ReadonlySet<string> = new Set([PRIVILEGE_ESCALATION, HOST_POWER])

const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])
const ESCALATE = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0'])

/**
 * ⚖️ O sudo e o reboot pelos comandos que RODAM (a análise do shell), não pelo texto: `grep "sudo"` e um script que só
 * cita "reboot" passavam por escalada. O `ssh` com sudo no comando remoto conta como escalada (quem libera é a regra:
 * `remoteSudoAllowed`). Comando que a análise não vê por inteiro: vale o texto (falha fechada).
 */
export function realReasons(analysis: { commands: ReadonlyArray<{ name: string; argv: readonly string[] }>; opaque: readonly string[] }, textual: readonly string[]): string[] {
  if (analysis.opaque.length) return textual.filter((reason) => COMMAND_REASONS.has(reason))
  const found = new Set<string>()
  for (const command of analysis.commands) {
    if (ESCALATE.has(command.name)) found.add(PRIVILEGE_ESCALATION)
    if (POWER.has(command.name) || (command.name === 'systemctl' && command.argv.some((word) => POWER.has(word) || word === 'kexec'))) found.add(HOST_POWER)
    if (command.name === 'ssh' && command.argv.slice(1).some((word) => /(^|[\s;&|(])sudo(\s|$)/.test(word))) found.add(PRIVILEGE_ESCALATION)
    if (command.name === 'ssh' && command.argv.slice(1).some((word) => /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)(\s|$)/.test(word))) found.add(HOST_POWER)
  }
  return textual.filter((reason) => COMMAND_REASONS.has(reason) && found.has(reason))
}

export function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  return `${output.substring(0, maxChars)}\n...[truncated at ${maxChars} characters]`
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
