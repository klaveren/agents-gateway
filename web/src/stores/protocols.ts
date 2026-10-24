import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import type { IProtocolInfo } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useProvidersStore } from './providers'

/** A cor de cada fabricante: o avatar diz de quem é a conversa antes de ler o nome. */
const BRAND_COLOR: Record<IProtocolInfo['brand'], string> = { claude: 'bg-claude', openai: 'bg-openai', google: 'bg-google' }

/**
 * Os protocolos como o servidor os descreve (`GET /protocols`): lanes, níveis de raciocínio, assinatura,
 * rótulo, console. ⚖️ A tela não guarda cópia: a regra mora no servidor, que é quem recusa.
 */
export const useProtocolsStore = defineStore('protocols', () => {
  const list = ref<IProtocolInfo[]>([])
  const loaded = ref(false)
  const byId = computed(() => new Map(list.value.map((protocol) => [protocol.id as string, protocol])))

  async function load(): Promise<void> {
    list.value = await api<IProtocolInfo[]>('/protocols')
    loaded.value = true
  }

  function get(protocol: string | undefined): IProtocolInfo | undefined {
    return protocol ? byId.value.get(protocol) : undefined
  }

  /** Os níveis escolhidos que o protocolo aceita, na ordem dele. */
  function levelsFor(protocol: string, chosen: readonly string[]): string[] {
    return (get(protocol)?.reasoningLevels ?? []).filter((level) => chosen.includes(level))
  }

  /** O protocolo de um provider configurado: o do banco (admin), senão o que vem no agente. */
  function protocolOf(providerId: string): string | undefined {
    const providers = useProvidersStore()
    const agents = useAgentsStore()
    return providers.list.find((provider) => provider.id === providerId)?.protocol ?? agents.list.find((agent) => agent.provider === providerId)?.providerInfo?.protocol
  }

  /** O nome do provider como está no banco; sem ele (membro, que não lê `/providers`), o do agente, senão o id. */
  function providerName(providerId: string): string {
    const providers = useProvidersStore()
    const agents = useAgentsStore()
    return providers.names.get(providerId) ?? agents.list.find((agent) => agent.provider === providerId)?.providerInfo?.name ?? providerId
  }

  /** A cor do avatar pela marca do protocolo; neutra quando não se sabe (compatível sem protocolo conhecido). */
  function providerColor(providerId: string): string {
    const brand = get(protocolOf(providerId))?.brand
    return brand ? BRAND_COLOR[brand] : 'bg-zinc-600'
  }

  return { list, loaded, byId, load, get, levelsFor, protocolOf, providerName, providerColor }
})
