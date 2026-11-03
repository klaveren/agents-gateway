import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IInstalledPackage, IPackageHit, IPackagesState } from '@/lib/types'

/** A guia Pacotes (só admin): o que está instalado em `<dados>/tools` (chave única `''`) e a busca no conda-forge. */
export const usePackagesStore = defineStore('packages', () => {
  const resource = keyedResource(() => api<IPackagesState>('/packages'))
  const state = computed(() => resource.get(''))

  async function load(): Promise<void> {
    await resource.refresh('')
  }

  async function ensure(): Promise<void> {
    await resource.ensure('')
  }

  /** A busca: cada termo é uma pergunta nova — lida na hora, não guardada. */
  async function search(query: string): Promise<IPackageHit[]> {
    return api<IPackageHit[]>(`/packages/search?q=${encodeURIComponent(query)}`)
  }

  /** Instala ou remove (pode levar minutos). `ok: false` traz o log do micromamba. */
  async function install(name: string): Promise<{ ok: boolean; log: string }> {
    const result = await api<{ ok: boolean; log: string; packages: IInstalledPackage[] }>('/packages', { method: 'POST', body: { name } })
    resource.update('', (current) => ({ ...current, packages: result.packages }))
    return result
  }

  async function remove(name: string): Promise<{ ok: boolean; log: string }> {
    const result = await api<{ ok: boolean; log: string; packages: IInstalledPackage[] }>(`/packages/${encodeURIComponent(name)}`, { method: 'DELETE' })
    resource.update('', (current) => ({ ...current, packages: result.packages }))
    return result
  }

  /** Esquece o que é de quem administrava (logout). */
  function reset(): void {
    resource.clear()
  }

  return { resource, state, load, ensure, search, install, remove, reset }
})
