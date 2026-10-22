import { TClassification } from '@domain/models/Classification.Model'

export interface IClassifierInput {
  request: string
  answer: string
  tools: string[]
}

/**
 * Quem rotula um turno. O domínio não sabe que é um modelo do outro lado.
 *
 * ⛔ NENHUM MÉTODO AQUI PODE DERRUBAR UM TURNO. Classificar é observação: se o classificador cair,
 * ficar caro ou demorar, a conversa acontece igual e o rótulo simplesmente não existe. É o mesmo
 * princípio do repositório de conversa — perder o registro é ruim, perder o turno de quem estava
 * trabalhando é pior. Por isso `undefined` é resposta válida, e o contrato é NUNCA lançar.
 */
export interface ITurnClassifier {
  classify(input: IClassifierInput): Promise<TClassification | undefined>
}
