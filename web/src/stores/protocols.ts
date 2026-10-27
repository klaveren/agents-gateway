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

  /** O provider como vem nos agentes — a fonte de quem não administra (membro não lê `/providers`). */
  function fromAgents(providerId: string) {
    for (const agent of useAgentsStore().list) {
      const found = agent.providers.find((provider) => provider.id === providerId)
      if (found) return found
    }
    return undefined
  }

  /** O protocolo de um provider configurado: o do banco (admin), senão o que vem no agente. */
  function protocolOf(providerId: string): string | undefined {
    return useProvidersStore().list.find((provider) => provider.id === providerId)?.protocol ?? fromAgents(providerId)?.protocol
  }

  /** O nome do provider como está no banco; sem ele (membro, que não lê `/providers`), o do agente, senão o id. */
  function providerName(providerId: string): string {
    return useProvidersStore().names.get(providerId) ?? fromAgents(providerId)?.name ?? providerId
  }

  /** A cor do avatar pela marca do protocolo; neutra quando não se sabe (compatível sem protocolo conhecido). */
  function providerColor(providerId: string): string {
    const brand = get(protocolOf(providerId))?.brand
    return brand ? BRAND_COLOR[brand] : 'bg-zinc-600'
  }

  return { list, loaded, byId, load, get, levelsFor, protocolOf, providerName, providerColor }
})
