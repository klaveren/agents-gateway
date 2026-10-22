import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentSettings } from '@domain/models/Settings.Model'
import { TClassification } from '@domain/models/Classification.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { IClassifierInput, ITurnClassifier } from '@domain/ports/TurnClassifier.Port'
import { apiKeyOf, makeComplete, providerOfModel } from './Classifier.Completion'
import { LlmTurnClassifier, TComplete } from './Llm.TurnClassifier'

/**
 * Qual modelo classifica: o das configurações, senão o de `CLASSIFIER_MODEL`, senão nenhum.
 *
 * ⚖️ A ORDEM É A DA OPERAÇÃO: o que se muda em runtime vence o que veio do deploy. Não há modelo
 * "padrão de fábrica" — escolher um por quem opera mandaria texto de conversa a um provider que ele
 * não decidiu usar, e essa é uma decisão de privacidade, não de conveniência.
 */
export function resolveClassifierModel(settings: IAgentSettings | undefined, envModel: string | undefined): string | undefined {
  return settings?.classifierModel?.trim() || envModel?.trim() || undefined
}

export interface IConfiguredClassifierDeps {
  settings: ISettingsRepository
  prompt: string
  /** `CLASSIFIER_MODEL`. Injetável para o teste não depender do ambiente. */
  envModel?: string
  /** Monta o `complete` de um modelo, ou `undefined` se não dá (provider desconhecido, sem chave). */
  build?: (model: string) => TComplete | undefined
  warn?: (message: string) => void
}

/** O padrão: provider pelo registry, chave pelo ambiente, SDK plano. */
function buildFromEnvironment(model: string): TComplete | undefined {
  const provider = providerOfModel(model)
  const apiKey = provider ? apiKeyOf(provider) : undefined

  return provider && apiKey ? makeComplete(provider, model, apiKey) : undefined
}

/** Por que o `complete` de um modelo não pôde ser montado — para o log. */
function whyNot(model: string): string {
  const provider: EProvider | undefined = providerOfModel(model)
  if (!provider) return `não sei de qual provider é o modelo "${model}"`

  return `falta a chave de API do provider ${provider}`
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
  private readonly build: (model: string) => TComplete | undefined
  private readonly warn: (message: string) => void

  constructor(private readonly deps: IConfiguredClassifierDeps) {
    this.build = deps.build ?? buildFromEnvironment
    this.warn = deps.warn ?? ((message) => console.warn(message))
  }

  async classify(input: IClassifierInput): Promise<TClassification | undefined> {
    try {
      const settings = await this.deps.settings.read()
      if (settings.classifyTurns !== true) return undefined

      const model = resolveClassifierModel(settings, this.deps.envModel)
      if (!model) return undefined

      const complete = this.completeFor(model)
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
    const model = resolveClassifierModel(settings, this.deps.envModel)

    if (settings?.classifyTurns !== true) return '[classifier] desligado (classifyTurns não está ligado nas configurações).'
    if (!model) return '[classifier] desligado: ligado nas configurações, mas sem modelo (defina classifierModel ou CLASSIFIER_MODEL).'
    if (!this.completeFor(model)) return `[classifier] desligado: ${whyNot(model)}.`

    return `[classifier] ligado com o modelo ${model}.`
  }

  /** Cacheado por modelo: o cliente do SDK não precisa ser recriado a cada turno. */
  private completeFor(model: string): TComplete | undefined {
    if (this.completions.has(model)) return this.completions.get(model)

    const complete = this.build(model)
    this.completions.set(model, complete)

    if (!complete && !this.warned.has(model)) {
      this.warned.add(model)
      this.warn(`[classifier] sem classificação: ${whyNot(model)}.`)
    }

    return complete
  }
}
