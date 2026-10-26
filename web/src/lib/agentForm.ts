import type { IProtocolInfo, IProviderStatus, TMode } from './types'

/** Só o que a poda precisa de uma ferramenta nativa. */
export interface INativeRef {
  id: string
  protocol: string
}

/** O catálogo de um provider chegou: ficam os modelos que ele oferece; sem nenhum, o primeiro ativado vira o padrão. */
export function pruneModels(current: readonly string[], offered: readonly string[]): string[] {
  const kept = current.filter((model) => offered.includes(model))
  return kept.length ? kept : offered.slice(0, 1)
}

/**
 * ⚠️ As nativas `sdk:` são da família do protocolo (claude-sub usa as do claude). Saiu um provider: as de
 * uma família que nenhum provider restante tem saem, senão o servidor recusa o salvamento. Sem as famílias
 * (protocolos não carregados), nada muda.
 */
export function pruneNatives(allowed: readonly string[], natives: readonly INativeRef[], families: readonly string[] | undefined): string[] {
  if (!families) return [...allowed]
  return allowed.filter((entry) => !entry.startsWith('sdk:') || natives.some((tool) => tool.id === entry && families.includes(tool.protocol)))
}

/** As lanes que ALGUM dos protocolos roda (assinatura só a agent). Sem protocolo conhecido, as duas. */
export function unionLanes(infos: ReadonlyArray<Pick<IProtocolInfo, 'lanes'> | undefined>): TMode[] {
  const known = infos.filter((info): info is Pick<IProtocolInfo, 'lanes'> => !!info)
  if (!known.length) return ['chat', 'agent']
  return (['chat', 'agent'] as TMode[]).filter((mode) => known.some((info) => info.lanes.includes(mode)))
}

/** Os níveis de raciocínio de todos os protocolos, sem repetir, na ordem em que aparecem. */
export function unionLevels(infos: ReadonlyArray<Pick<IProtocolInfo, 'reasoningLevels'> | undefined>): string[] {
  return [...new Set(infos.flatMap((info) => info?.reasoningLevels ?? []))]
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
