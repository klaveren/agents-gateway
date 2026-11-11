import { canonicalize, documentFromText, ICatalogDocument, TCanonicalBody } from './Catalog.Document'
import { IAgentTarget } from './models/Agent.Model'

/**
 * 🔌 O DOCUMENTO DA ORIGEM NA INSTALAÇÃO LOCAL (o projeto conectado). O catálogo chega como a origem o tem; antes de
 * gravar, o que é da MÁQUINA vira o daqui:
 *
 * - os MODELOS: o alvo cujo modelo está ativo aqui fica; o resto vai pelo mapa de modelos da conexão (`provider/modelo`
 *   da origem → `provider/modelo` daqui) e, sem mapa, para o modelo padrão desta instalação. Sem nenhum, o agente fica
 *   com o que veio (o plano diz o porquê e ele não entra);
 * - o GRUPO DE MODELOS da origem não existe aqui: sai (vale o padrão daqui);
 * - o COMPARTILHAMENTO com outros projetos da origem (`sharedWith`) não tem sentido aqui: sai.
 */
export interface ILocalModels {
  /** O modelo roda aqui (provider configurado, modelo ativo)? */
  enabled(provider: string, model: string): boolean
  /** `provider/modelo` da origem → o daqui, escolhido na conexão. */
  map: Readonly<Record<string, string>>
  /** O modelo padrão desta instalação (as Configurações), quando há. */
  fallback?: { provider: string; model: string }
}

/** Uma chave do mapa: `provider/modelo`. */
export const modelKey = (provider: string, model: string) => `${provider}/${model}`

/** Os alvos do agente como rodam aqui (a ordem da origem fica; alvo repetido se junta). */
export function localTargets(targets: readonly IAgentTarget[], models: ILocalModels): IAgentTarget[] {
  const out: IAgentTarget[] = []
  const add = (base: IAgentTarget, provider: string, model: string) => {
    const same = out.find((target) => target.provider === provider)
    if (same) {
      if (!same.models.includes(model)) same.models.push(model)
      return
    }
    out.push({ ...base, provider, models: [model] })
  }
  for (const target of targets)
    for (const model of target.models) {
      if (models.enabled(target.provider, model)) {
        add(target, target.provider, model)
        continue
      }
      const mapped = models.map[modelKey(target.provider, model)]
      const [provider, ...rest] = mapped?.split('/') ?? []
      const chosen = provider && rest.length ? { provider, model: rest.join('/') } : models.fallback
      if (chosen && models.enabled(chosen.provider, chosen.model)) add(target, chosen.provider, chosen.model)
    }
  return out
}

/** O documento como entra aqui (ver o topo). O que não muda volta o mesmo objeto. */
export function forLocal(document: ICatalogDocument, models: ILocalModels): ICatalogDocument {
  const body: Record<string, unknown> = { ...(document.body as Record<string, unknown>) }
  let changed = false
  if (Array.isArray(body.sharedWith) && body.sharedWith.length) {
    delete body.sharedWith
    changed = true
  }
  if (document.kind === 'agent') {
    if (body.modelGroup !== undefined) {
      delete body.modelGroup
      changed = true
    }
    const targets = Array.isArray(body.providers) ? (body.providers as IAgentTarget[]) : []
    const local = localTargets(targets, models)
    if (local.length && JSON.stringify(local) !== JSON.stringify(targets)) {
      body.providers = local as unknown as TCanonicalBody[string]
      changed = true
    }
  }
  return changed ? documentFromText(document.kind, document.id, document.projectId, canonicalize(body as TCanonicalBody)) : document
}
