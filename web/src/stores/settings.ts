import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { ISettings } from '@/lib/types'

export const useSettingsStore = defineStore('settings', () => {
  const current = ref<ISettings>()

  async function load(): Promise<void> {
    current.value = await api<ISettings>('/settings')
  }

  /** Escrita parcial: `null` volta o campo ao padrão (ver `PUT /settings`). */
  async function save(patch: Partial<Record<keyof ISettings, unknown>>): Promise<void> {
    await api('/settings', { method: 'PUT', body: patch })
    await load()
  }

  return { current, load, save }
})
