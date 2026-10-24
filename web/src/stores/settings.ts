import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { ISettings } from '@/lib/types'

export const useSettingsStore = defineStore('settings', () => {
  const current = ref<ISettings>()

  /** ⚠️ Resposta que chega depois de um `reset()` (ou de outra carga) é descartada: não ressuscita dados de quem saiu. */
  let generation = 0

  async function load(): Promise<void> {
    const mine = ++generation
    const loaded = await api<ISettings>('/settings')
    if (mine === generation) current.value = loaded
  }

  /** Esquece as configurações (logout, ou quem deixou de ser admin). */
  function reset(): void {
    generation++
    current.value = undefined
  }

  /** Escrita parcial: `null` volta o campo ao padrão (ver `PUT /settings`). */
  async function save(patch: Partial<Record<keyof ISettings, unknown>>): Promise<void> {
    await api('/settings', { method: 'PUT', body: patch })
    await load()
  }

  return { current, load, save, reset }
})
