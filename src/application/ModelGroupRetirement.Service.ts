import { retireSteps } from '@domain/Fallback.Policy'
import { mergeSettings } from '@domain/models/Settings.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'

/**
 * ⚖️ A RETIRADA AUTOMÁTICA: só modelo habilitado fica nas sequências (grupos de modelos). Quando um modelo é desativado, some
 * da listagem do provider, ou o provedor é desligado/apagado, os passos com ele saem de TODAS as sequências na hora, nas
 * configurações, com o autor de quem desabilitou. A sequência que fica vazia continua: o agente usa os modelos dele.
 *
 * Idempotente: confere o estado de agora, não o evento — por isso serve também de limpeza no boot. As configurações não
 * têm histórico de revisões (só `updatedAt`/`updatedBy`); o catálogo de modelos grava quem desabilitou.
 */
export class ModelGroupRetirement {
  constructor(
    private readonly settings: ISettingsRepository,
    /** O passo pode rodar: provedor LIGADO e modelo ATIVADO no catálogo dele. */
    private readonly usable: (provider: string, model: string) => boolean,
  ) {}

  /** Tira dos grupos os passos que não servem. Devolve quantos saíram. */
  async retire(by: string): Promise<number> {
    const current = await this.settings.read()
    const groups = current.modelGroups
    if (!groups?.length) return 0
    const { groups: next, removed } = retireSteps(groups, (step) => this.usable(step.provider, step.model))
    if (!removed.length) return 0
    await this.settings.save(mergeSettings(current, { modelGroups: next }, by))
    for (const { group, step } of removed) console.warn(`[model-groups] ${step.provider}/${step.model} saiu do grupo ${group} (${by}): modelo ou provedor desabilitado`)
    return removed.length
  }
}
