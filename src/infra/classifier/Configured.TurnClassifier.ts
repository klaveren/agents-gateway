import { IAgentSettings } from '@domain/models/Settings.Model'
import { TClassification } from '@domain/models/Classification.Model'
import { IProviderConnection } from '@domain/models/Provider.Model'
import { IConnectionSource } from '@infra/adapters/support/Keyed.Client'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { IClassifierInput, ITurnClassifier } from '@domain/ports/TurnClassifier.Port'
import { isSubscription } from '@domain/Subscription.Policy'
import { makeComplete } from './Classifier.Completion'
import { LlmTurnClassifier, TComplete } from './Llm.TurnClassifier'

/**
 * Qual provider e qual modelo classificam: os das configurações, os dois, ou nenhum.
 *
 * ⚖️ SÓ O QUE FOI ESCOLHIDO NA TELA: não há `CLASSIFIER_MODEL` nem palpite de provider pelo prefixo
 * do id. Escolher por quem opera mandaria texto de conversa a um provider que ele não decidiu usar,
 * e essa é uma decisão de privacidade, não de conveniência.
 */
export function resolveClassifierTarget(settings: IAgentSettings | undefined): { providerId: string; model: string } | undefined {
  const providerId = settings?.classifierProvider?.trim()
  const model = settings?.classifierModel?.trim()

  return providerId && model ? { providerId, model } : undefined
}

export interface IConfiguredClassifierDeps {
  settings: ISettingsRepository
  prompt: string
  /** Os providers configurados: protocolo, URL e chave em vigor (`undefined` = desligado ou removido). */
  connections?: IConnectionSource
  /** O modelo está ativo no catálogo do provider? Ausente = não confere. */
  modelEnabled?: (providerId: string, modelId: string) => boolean
  /** Monta o `complete` de uma conexão. Injetável para o teste não ir à rede. */
  build?: (connection: IProviderConnection, model: string) => TComplete | undefined
  warn?: (message: string) => void
}

/**
 * O classificador que as configurações governam.
 *
 * ⚖️ TUDO É DECIDIDO A CADA TURNO, e não no boot: ligar, desligar e trocar o modelo são decisões de
 * operação, e uma decisão que só vale depois de reiniciar não é tomada na hora em que importa. O
 * custo é uma leitura de configuração por turno, e o repositório já responde sem ir ao banco.
 *
 * ⛔ LIGADO SÓ COM `classifyTurns === true`: ausente é desligado. Cada turno classificado é uma
 * chamada paga a um modelo, com o texto da conversa saindo para um provider; não se liga por omissão.
 *
 * ⛔ NUNCA LANÇA (ver `ITurnClassifier`): configuração ilegível, chave ausente ou provider fora do ar
 * viram "sem rótulo".
 */
export class ConfiguredTurnClassifier implements ITurnClassifier {
  private readonly completions = new Map<string, TComplete | undefined>()
  private readonly warned = new Set<string>()
  private readonly build: (connection: IProviderConnection, model: string) => TComplete | undefined
  private readonly warn: (message: string) => void

  constructor(private readonly deps: IConfiguredClassifierDeps) {
    this.build = deps.build ?? ((connection, model) => (connection.key ? makeComplete(connection.protocol, model, connection.key, connection.baseUrl) : undefined))
    this.warn = deps.warn ?? ((message) => console.warn(message))
  }

  async classify(input: IClassifierInput): Promise<TClassification | undefined> {
    try {
      const settings = await this.deps.settings.read()
      if (settings.classifyTurns !== true) return undefined

      const target = resolveClassifierTarget(settings)
      if (!target) return undefined

      const complete = this.completeFor(target.providerId, target.model)
      if (!complete) return undefined

      return await new LlmTurnClassifier(complete, this.deps.prompt).classify(input)
    } catch (error: unknown) {
      console.warn('[classifier] não foi possível classificar o turno:', error instanceof Error ? error.message : error)

      return undefined
    }
  }

  /** Uma linha para o boot: como o classificador está agora, e por quê. */
  async status(): Promise<string> {
    const settings = await this.deps.settings.read().catch(() => undefined)
    const target = resolveClassifierTarget(settings)

    if (settings?.classifyTurns !== true) return '[classifier] desligado (classifyTurns não está ligado nas configurações).'
    if (!target) return '[classifier] desligado: ligado nas configurações, mas sem provider e modelo (defina classifierProvider e classifierModel).'
    const why = this.whyNot(target.providerId, target.model)
    if (why) return `[classifier] desligado: ${why}.`

    return `[classifier] ligado com o modelo ${target.model} (${target.providerId}).`
  }

  /** Por que não dá para classificar com esse provider e modelo agora, ou `undefined` se dá. */
  private whyNot(providerId: string, model: string): string | undefined {
    const connection = this.deps.connections?.connection(providerId)
    if (!connection) return `o provider ${providerId} está desligado ou não existe`
    if (isSubscription(connection.protocol)) return `o provider ${providerId} é de assinatura, e o classificador usa chave de API`
    if (!connection.key) return `o provider ${providerId} está sem chave`
    if (this.deps.modelEnabled && !this.deps.modelEnabled(providerId, model)) return `o modelo ${model} não está ativo em ${providerId}`

    return undefined
  }

  /**
   * Cacheado pela conexão em vigor (provider, modelo, URL e chave): o cliente do SDK não é recriado
   * a cada turno, mas trocar a chave pela tela troca o cliente no turno seguinte.
   */
  private completeFor(providerId: string, model: string): TComplete | undefined {
    const why = this.whyNot(providerId, model)
    if (why) {
      const warning = `${providerId}\u0000${model}`
      if (!this.warned.has(warning)) {
        this.warned.add(warning)
        this.warn(`[classifier] sem classificação: ${why}.`)
      }
      return undefined
    }

    const connection = this.deps.connections!.connection(providerId)!
    const cacheKey = `${providerId}\u0000${model}\u0000${connection.baseUrl ?? ''}\u0000${connection.key}`
    if (!this.completions.has(cacheKey)) this.completions.set(cacheKey, this.build(connection, model))

    return this.completions.get(cacheKey)
  }
}
