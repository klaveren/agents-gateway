import { INextStepSuggester } from '@domain/ports/NextStepSuggester.Port'
import { ConfiguredNextStepSuggester } from '@infra/suggest/Configured.NextStepSuggester'
import { makeModelCatalog } from './Catalog.Factory'
import { makeProviders } from './Providers.Factory'
import { makeSettings } from './Settings.Factory'

let instance: INextStepSuggester | undefined

/**
 * A sugestão de próximo passo. ⚖️ SEMPRE MONTADA, como o classificador: quem a liga é a escolha do modelo nas configurações,
 * lida a cada turno. Sem modelo escolhido, nenhuma chamada.
 */
export function makeSuggester(): INextStepSuggester {
  instance ??= new ConfiguredNextStepSuggester({
    settings: makeSettings(),
    connections: makeProviders(),
    modelEnabled: (providerId, modelId) => makeModelCatalog().isEnabled(providerId, modelId),
  })
  return instance
}
