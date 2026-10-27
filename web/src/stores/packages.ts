import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IInstalledPackage, IPackageHit, IPackagesState } from '@/lib/types'

/** A guia Pacotes (só admin): o que está instalado em `<dados>/tools` e a busca no conda-forge. */
export const usePackagesStore = defineStore('packages', () => {
  const state = ref<IPackagesState>()

  async function load(): Promise<void> {
    state.value = await api<IPackagesState>('/packages')
  }

  async function search(query: string): Promise<IPackageHit[]> {
    return api<IPackageHit[]>(`/packages/search?q=${encodeURIComponent(query)}`)
  }

  /** Instala ou remove (pode levar minutos). `ok: false` traz o log do micromamba. */
  async function install(name: string): Promise<{ ok: boolean; log: string }> {
    const result = await api<{ ok: boolean; log: string; packages: IInstalledPackage[] }>('/packages', { method: 'POST', body: { name } })
    if (state.value) state.value = { ...state.value, packages: result.packages }
    return result
  }

  async function remove(name: string): Promise<{ ok: boolean; log: string }> {
    const result = await api<{ ok: boolean; log: string; packages: IInstalledPackage[] }>(`/packages/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (state.value) state.value = { ...state.value, packages: result.packages }
    return result
  }

  return { state, load, search, install, remove }
})
