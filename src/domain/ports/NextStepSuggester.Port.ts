/** O turno que a sugestão lê: o que a pessoa mandou e o que o agente respondeu. */
export interface ISuggestionInput {
  request: string
  answer: string
}

/**
 * Quem sugere a PRÓXIMA mensagem da pessoa (ver `ConfiguredNextStepSuggester`). O domínio não sabe que é um modelo.
 *
 * ⛔ NUNCA LANÇA, como o classificador: a sugestão é conveniência, e nada nela pode derrubar o turno. `undefined` = sem
 * sugestão (desligada, sem próximo passo óbvio, o modelo fora do ar).
 */
export interface INextStepSuggester {
  suggest(input: ISuggestionInput): Promise<string | undefined>
}
