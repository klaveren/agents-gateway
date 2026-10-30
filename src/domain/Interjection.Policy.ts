/**
 * ⚖️ MENSAGEM DURANTE O TURNO: com o turno rodando, a mensagem nova não é recusada (`whileBusy: 'queue'`); ela espera
 * numa fila da conversa e entra no MESMO turno, na primeira chance da lane:
 * - entre uma ferramenta e a próxima chamada ao modelo, nas lanes que têm onde pô-la (chat; o Claude, pelo `PostToolUse`);
 * - senão, numa rodada a mais quando o modelo termina (todas as lanes; no Codex e no Antigravity é o único caminho).
 * O turno parado (cancelado, com erro, em laço) descarta a fila, com aviso.
 */

/** Quantas mensagens esperam por conversa. */
export const INTERJECTION_QUEUE_MAX = 10

/** A mensagem que entra no meio do turno, para o modelo: é da pessoa, não da ferramenta. */
export function interjectionNote(texts: string[]): string {
  return `[Mensagem nova da pessoa, enviada enquanto você trabalhava — leve em conta daqui em diante:]\n\n${texts.join('\n\n')}`
}

/** A rodada a mais no fim do turno: as mensagens como a próxima fala da pessoa. */
export function interjectionRound(texts: string[]): string {
  return texts.join('\n\n')
}
