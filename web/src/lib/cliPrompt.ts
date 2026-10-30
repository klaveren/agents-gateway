import type { ICliFootprint } from './types'

/**
 * ⚖️ O PROMPT NO CLI: o Codex e o Antigravity recebem o prompt montado (soul, instrução, rules, índices, contexto
 * inicial) como UM argumento de linha de comando, e o Linux recusa um argumento acima de 128 KiB — a conversa nesses
 * provedores falha (o servidor recusa antes, com o motivo). A tela só AVISA: o tamanho é de quem cria o agente.
 * Os mesmos números do servidor (`CliArgument.Policy`).
 */
export const CLI_ARG_MAX_BYTES = 128 * 1024 - 1
export const CLI_ARG_WARN_RATIO = 0.8

export type TCliLevel = 'ok' | 'warn' | 'over'

export interface ICliEstimate {
  bytes: number
  limit: number
  percent: number
  level: TCliLevel
  /** As partes que mais pesam, da maior para a menor. */
  heavy: Array<{ label: string; bytes: number }>
  /** `false`: sem o ambiente (agente não salvo, ou salvo sem CLI) — só o soul e a instrução. */
  withEnvironment: boolean
}

interface IIdentity {
  soul?: string
  systemPrompt: string
}

const utf8 = (text: string) => new TextEncoder().encode(text).length

/** O soul como o servidor o embrulha antes da instrução (`composeSystemPrompt`). */
function soulText(soul: string | undefined): string {
  const trimmed = soul?.trim()
  return trimmed ? `## Quem você é\n${trimmed}\n\n## Como você trabalha\n` : ''
}

/** O peso de um texto dentro do argumento: no Codex, com o escape da string TOML (o `JSON.stringify` do SDK). */
function argBytes(text: string, codex: boolean): number {
  return codex ? utf8(JSON.stringify(text)) - 2 : utf8(text)
}

/**
 * O argumento estimado com o que está na tela: o medido no servidor (com o ambiente do projeto), trocando o soul e a
 * instrução SALVOS pelos do formulário. Sem a medida do servidor, só o soul e a instrução.
 */
export function cliPromptEstimate(input: { cli?: ICliFootprint; saved?: IIdentity; live: IIdentity; codex: boolean }): ICliEstimate {
  const { cli, saved, live, codex } = input
  const liveIdentity = soulText(live.soul) + live.systemPrompt
  const measured = cli && saved
  const bytes = measured
    ? cli.bytes - argBytes(soulText(saved.soul) + saved.systemPrompt, codex) + argBytes(liveIdentity, codex)
    : argBytes(liveIdentity, codex) + utf8(codex ? 'developer_instructions=""' : '-p=\n\n---\n\n')
  const limit = cli?.limit ?? CLI_ARG_MAX_BYTES
  const warnAt = cli?.warnAt ?? Math.floor(limit * CLI_ARG_WARN_RATIO)
  const parts = [
    { label: 'Soul', bytes: utf8(soulText(live.soul)) },
    { label: 'Instrução do sistema', bytes: utf8(live.systemPrompt) },
    ...(measured ? cli.parts.filter((part) => part.key !== 'soul' && part.key !== 'instructions') : []),
  ]
  const heavy = parts
    .filter((part) => part.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map(({ label, bytes: weight }) => ({ label, bytes: weight }))
  return {
    bytes,
    limit,
    percent: Math.round((bytes / limit) * 100),
    level: bytes > limit ? 'over' : bytes >= warnAt ? 'warn' : 'ok',
    heavy,
    withEnvironment: !!measured,
  }
}

/** Bytes em KiB, com uma casa (`97,7 KiB`). */
export function kib(bytes: number): string {
  return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KiB`
}
