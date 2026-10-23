import type { IProtocolInfo, IProviderStatus, TMode } from './types'

/** Só o que a poda precisa de uma ferramenta nativa. */
export interface INativeRef {
  id: string
  protocol: string
}

/** Trocou o provider: ficam os modelos que o novo oferece; sem nenhum, o primeiro ativado vira o padrão. */
export function pruneModels(current: readonly string[], offered: readonly string[]): string[] {
  const kept = current.filter((model) => offered.includes(model))
  return kept.length ? kept : offered.slice(0, 1)
}

/**
 * ⚠️ As nativas `sdk:` são da família do protocolo (claude-sub usa as do claude). Trocou o provider: as de
 * outra família saem, senão o servidor recusa o salvamento. Sem a família (protocolos não carregados), nada muda.
 */
export function pruneNatives(allowed: readonly string[], natives: readonly INativeRef[], family: string | undefined): string[] {
  if (!family) return [...allowed]
  return allowed.filter((entry) => !entry.startsWith('sdk:') || natives.some((tool) => tool.id === entry && tool.protocol === family))
}

/** As lanes de partida de um protocolo: as que ele aceita; assinatura, só `agent`. */
export function defaultLanes(info: Pick<IProtocolInfo, 'lanes' | 'subscription'> | undefined): TMode[] {
  if (!info) return ['chat', 'agent']
  if (info.subscription) return ['agent']
  return info.lanes.length ? [...info.lanes] : ['agent']
}

/** Quem pode ser o provider de um agente novo: ligado e com chave (ou assinatura). */
export function isUsableProvider(provider: Pick<IProviderStatus, 'enabled' | 'subscription' | 'credential'>, protocol?: Pick<IProtocolInfo, 'subscription'>): boolean {
  return provider.enabled && (provider.credential.configured || !!provider.subscription || !!protocol?.subscription)
}

/** O que a tela oferece hoje; `undefined` = ainda não carregou (então nada é órfão). */
export interface IOffered {
  /** Ids `sdk:…` das nativas do protocolo atual. */
  natives?: ReadonlySet<string>
  /** Ids dos outros agentes (`agent:<id>`, sem o prefixo). */
  agents?: ReadonlySet<string>
  /** Decide se uma entrada `mcp:…` está disponível. */
  mcp?: (entry: string) => boolean
}

/**
 * As entradas `sdk:`, `agent:` e `mcp:` de `allowedTools` que nenhuma lista oferecida cobre. Elas não têm
 * checkbox na tela, mas o servidor recusa o salvamento por causa delas: a tela as mostra para tirar.
 */
export function findOrphans(allowed: readonly string[], offered: IOffered): string[] {
  return allowed.filter((entry) => {
    if (entry.startsWith('sdk:')) return !!offered.natives && !offered.natives.has(entry)
    if (entry.startsWith('agent:')) return !!offered.agents && !offered.agents.has(entry.slice(6))
    if (entry.startsWith('mcp:')) return !!offered.mcp && !offered.mcp(entry)
    return false
  })
}

/** O resumo de um 422 perto do Salvar: todos os campos, também os que não têm input na tela. */
export function summarizeIssues(issues: Record<string, string[]>, labels: Record<string, string>): string {
  return Object.entries(issues)
    .map(([field, messages]) => {
      const text = messages.join('; ')
      return field && field !== '_' ? `${labels[field] ?? field} (${text})` : text
    })
    .join(' · ')
}
