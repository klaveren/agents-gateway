/** O que fechou o turno sem dar certo: a ferramenta e o motivo. */
export interface ITurnFailure {
  tool: string
  reason: string
}

/** O motivo em até duas linhas e ~300 caracteres: é o resumo do que falhou, não a saída inteira. */
function shortReason(reason: string): string {
  const lines = reason
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
  return lines.length > 300 ? `${lines.slice(0, 299)}…` : lines
}

/**
 * ⛔ O TURNO QUE TERMINA VAZIO DEPOIS DE UMA FERRAMENTA QUE FALHOU: a conversa e quem delegou recebiam nada (9 turnos da
 * Vera no Antigravity, 26/11). O gateway fecha o turno com o que falhou, marcado como dele. Só o fato: nunca uma
 * conclusão que o agente não deu.
 */
export function emptyTurnSummary(failure: ITurnFailure): string {
  const reason = shortReason(failure.reason) || 'sem motivo informado'
  return `[gateway] O agente terminou o turno sem resposta. Parou em \`${failure.tool}\`: ${reason}. Próximo passo: peça para ele continuar (ou corrija o que falhou).`
}
