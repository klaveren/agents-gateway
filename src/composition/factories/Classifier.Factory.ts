import { ITurnClassifier } from '@domain/ports/TurnClassifier.Port'
import { loadClassifierPrompt } from '@infra/classifier/Classifier.Prompt'
import { ConfiguredTurnClassifier } from '@infra/classifier/Configured.TurnClassifier'
import { makeSettings } from './Settings.Factory'

let instance: ITurnClassifier | undefined

/**
 * O classificador de turno.
 *
 * ⚖️ SEMPRE MONTADO, e quem o liga é a configuração (`classifyTurns`), lida a cada turno. Montar só
 * quando uma variável de ambiente manda faria a tela de configuração mentir: o botão mudaria e nada
 * aconteceria até o próximo deploy. Desligado, ele não faz chamada nenhuma.
 *
 * Uma linha no boot diz se está ligado e, se não, por quê (sem modelo, sem chave).
 */
export function makeClassifier(): ITurnClassifier {
  if (instance) return instance

  const classifier = new ConfiguredTurnClassifier({
    settings: makeSettings(),
    prompt: loadClassifierPrompt(),
    envModel: process.env.CLASSIFIER_MODEL,
  })

  // `void`: o boot não espera pelo banco, e `status` nunca lança.
  void classifier.status().then((line) => console.log(line))

  instance = classifier

  return classifier
}
