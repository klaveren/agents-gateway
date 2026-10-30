import { EProvider } from './enums/EProvider.Enum'

/**
 * ⚖️ A TRAVA TÉCNICA DO PROMPT NAS LANES DE CLI: o Codex e o Antigravity recebem o prompt montado (soul, instrução,
 * rules, índices, contexto inicial e ambiente) como UM argumento de linha de comando, e o Linux recusa um argumento
 * acima de 128 KiB (`MAX_ARG_STRLEN`, com o NUL do fim). Passou, o `spawn` falha com `E2BIG` — sem dizer o porquê.
 *
 * ⛔ NÃO É TETO DE CONTEÚDO: o tamanho é de quem cria o agente. Daqui sai só o erro claro antes do `spawn` (nas duas
 * lanes de CLI, nunca nas outras) e o aviso da tela. O mesmo número em todo lugar: o gateway roda em Linux, e um agente
 * que passa no Mac e quebra na VM é pior.
 */
export const CLI_ARG_MAX_BYTES = 128 * 1024 - 1
/** A partir daqui a tela avisa (sem bloquear): no Antigravity a primeira mensagem vai no mesmo argumento. */
export const CLI_ARG_WARN_RATIO = 0.8

/** As lanes que passam o prompt como argumento de linha de comando. */
export const CLI_ARG_PROTOCOLS: readonly EProvider[] = [EProvider.CODEX, EProvider.ANTIGRAVITY]

/**
 * O argumento que um prompt vira em cada CLI, em bytes. Codex: `developer_instructions=` e o texto como string TOML (o
 * `JSON.stringify` do SDK — quebra de linha e aspas viram escape). Antigravity: `-p=`, o prompt e o separador antes da
 * mensagem (a mensagem não entra: a conta é do agente).
 */
export function cliArgumentBytes(protocol: EProvider, prompt: string): number {
  if (protocol === EProvider.CODEX) return Buffer.byteLength(`developer_instructions=${JSON.stringify(prompt)}`)
  return Buffer.byteLength(`-p=${prompt}\n\n---\n\n`)
}

/** Uma parte do prompt e o peso dela em bytes. */
export interface ICliPromptPart {
  label: string
  bytes: number
}

/** Os títulos que o `composeSystemPrompt` põe no soul e na instrução, com o nome que a tela usa. */
const HEADING_LABEL: Record<string, string> = { 'Quem você é': 'Soul', 'Como você trabalha': 'Instrução do sistema' }

/**
 * As partes de um prompt montado, pelos títulos `## ` (o soul, as rules, as specs, os índices, o ambiente…). O que vem
 * antes do primeiro título é a instrução do sistema.
 */
export function promptParts(text: string, firstLabel = 'Instrução do sistema'): ICliPromptPart[] {
  const parts: ICliPromptPart[] = []
  let label = firstLabel
  let lines: string[] = []
  const flush = () => {
    const body = lines.join('\n')
    if (body.trim()) parts.push({ label, bytes: Buffer.byteLength(body) })
  }
  for (const line of text.split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      flush()
      label = HEADING_LABEL[heading[1].trim()] ?? heading[1].trim()
      lines = [line]
    } else lines.push(line)
  }
  flush()
  return parts
}

/** As partes mais pesadas, da maior para a menor (as do mesmo título somadas). */
export function heaviestParts(parts: readonly ICliPromptPart[], count = 3): ICliPromptPart[] {
  const sums = new Map<string, number>()
  for (const part of parts) sums.set(part.label, (sums.get(part.label) ?? 0) + part.bytes)
  return [...sums]
    .map(([label, bytes]) => ({ label, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count)
}

/**
 * O erro de um argumento que não cabe: o tamanho, o limite e o que pesa. `undefined` = cabe.
 * @param cli o nome do CLI na mensagem (Codex, Antigravity).
 * @param argBytes o argumento INTEIRO, como vai ao `spawn` (com a flag e o escape).
 */
export function cliArgumentIssue(cli: string, argBytes: number, parts: readonly ICliPromptPart[], limit = CLI_ARG_MAX_BYTES): string | undefined {
  if (argBytes <= limit) return undefined
  const heavy = heaviestParts(parts)
  const weights = heavy.length ? ` O que mais pesa: ${heavy.map((part) => `${part.label} (${kb(part.bytes)})`).join(', ')}.` : ''
  return (
    `O prompt não cabe no ${cli}: ${kb(argBytes)} (${argBytes.toLocaleString('pt-BR')} bytes) num argumento de linha de comando, ` +
    `e o Linux aceita até ${kb(limit)} (${limit.toLocaleString('pt-BR')} bytes).${weights} ` +
    `Enxugue essas partes ou use este agente num provedor que não seja Codex nem Antigravity.`
  )
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KiB`
}
