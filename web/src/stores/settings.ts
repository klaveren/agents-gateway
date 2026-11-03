import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { ISettings } from '@/lib/types'

/**
 * As configurações do sistema (só admin), chave única `''`. ⚖️ Trazem o que muda sozinho (os provedores sem cota, o
 * estado do cerco): o `ensure` lê de novo depois de um minuto. O início do app as guarda da pergunta "é admin?"
 * (`seed`), sem uma segunda leitura.
 */
export const useSettingsStore = defineStore('settings', () => {
  const resource = keyedResource(() => api<ISettings>('/settings'), { staleMs: 60_000 })
  const current = computed(() => resource.get(''))

  /** ⚠️ Resposta que chega depois de um `reset()` (ou de outra carga) é descartada: não ressuscita dados de quem saiu. */
  async function load(): Promise<void> {
    await resource.refresh('')
  }

  async function ensure(): Promise<void> {
    await resource.ensure('')
  }

  /** Guarda o que outra leitura de `GET /settings` já trouxe. */
  function seed(settings: ISettings): void {
    resource.set('', settings)
  }

  /** Esquece as configurações (logout, ou quem deixou de ser admin). */
  function reset(): void {
    resource.clear()
  }

  /**
   * Escrita parcial: `null` volta o campo ao padrão (ver `PUT /settings`). ⚖️ A resposta é só o gravado, sem o que vale
   * no lugar do vazio (`defaults`, `limitsInEffect`…): relê.
   */
  async function save(patch: Partial<Record<keyof ISettings, unknown>>): Promise<void> {
    await api('/settings', { method: 'PUT', body: patch })
    await load()
  }

  return { resource, current, load, ensure, seed, save, reset }
})
