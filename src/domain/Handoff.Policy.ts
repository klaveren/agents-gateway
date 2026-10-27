/**
 * O repasse de uma conversa quando ela troca de provider no meio (ver `AgentProvider.reconfigure`).
 *
 * ⚖️ O histórico de cada provider mora no SDK dele — a sessão do CLI do Claude, a thread do Codex, o
 * ADK, os itens do `@openai/agents` — e um não lê o do outro. O que atravessa é a TRANSCRIÇÃO: o que a
 * pessoa pediu, o que foi respondido e que ferramentas rodaram. O estado interno (ids de tool,
 * raciocínio cifrado, cache) fica para trás.
 */

/** Um turno da conversa, em texto — o que o provider seguinte precisa para continuar. */
export interface ITranscriptTurn {
  request: string
  /** Só os nomes: o conteúdo dos arquivos não atravessa. */
  files?: string[]
  text: string
  /** As ferramentas que rodaram no turno, pelo nome. */
  tools?: string[]
  /** Quem respondeu: `provider · modelo`. */
  by?: string
}

/** ⚖️ ~40 mil caracteres: cabe com folga no contexto de qualquer modelo e não paga uma conversa inteira de volta. */
export const HANDOFF_MAX_CHARS = 40_000

/**
 * O bloco que vai antes da primeira mensagem no provider novo. `undefined` quando não há o que repassar.
 *
 * Os turnos mais RECENTES ficam; os mais antigos que não cabem saem, e o bloco diz quantos saíram.
 * Um turno sozinho maior que o teto entra cortado, para o mais recente nunca sumir.
 */
/** Por que a transcrição vai: a conversa trocou de provider no meio, ou foi RETOMADA (a sessão tinha expirado). */
export type THandoffKind = 'switch' | 'resume'

const HANDOFF_INTRO: Record<THandoffKind, string> = {
  switch:
    '[Contexto do sistema: esta conversa começou com outro modelo e continua com você. Abaixo, a transcrição dos turnos anteriores — use-a para manter a continuidade, sem respondê-la de novo. A mensagem nova da pessoa vem depois da transcrição.]',
  resume:
    '[Contexto do sistema: esta conversa foi retomada depois de uma pausa — o que você lembrava dela se perdeu. Abaixo, a transcrição dos turnos anteriores — use-a para continuar de onde parou, sem respondê-la de novo. A mensagem nova da pessoa vem depois da transcrição.]',
}

export function handoffText(turns: readonly ITranscriptTurn[], maxChars = HANDOFF_MAX_CHARS, kind: THandoffKind = 'switch'): string | undefined {
  if (!turns.length) return undefined

  const blocks = turns.map((turn, index) => turnBlock(turn, index + 1))
  const kept: string[] = []
  let size = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (size + block.length > maxChars) {
      if (!kept.length) kept.unshift(`${block.slice(0, maxChars)}\n[…turno cortado]`)
      break
    }
    kept.unshift(block)
    size += block.length
  }

  const omitted = blocks.length - kept.length
  return [HANDOFF_INTRO[kind], ...(omitted ? [`[${omitted} turno(s) mais antigo(s) omitido(s).]`] : []), ...kept, '[Fim da transcrição. Mensagem nova:]'].join('\n\n')
}

function turnBlock(turn: ITranscriptTurn, number: number): string {
  const lines = [`### Turno ${number}${turn.by ? ` (${turn.by})` : ''}`, `Pessoa: ${turn.request.trim() || '(sem texto)'}`]
  if (turn.files?.length) lines.push(`Arquivos anexados: ${turn.files.join(', ')}`)
  if (turn.tools?.length) lines.push(`Ferramentas usadas: ${[...new Set(turn.tools)].join(', ')}`)
  lines.push(`Assistente: ${turn.text.trim() || '(sem texto)'}`)
  return lines.join('\n')
}
