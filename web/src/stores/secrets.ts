import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** Um valor mascarado: ⛔ o valor entra e nunca volta (só o fim dele). */
export interface ISecretValue {
  id: string
  label: string
  last4?: string
  updatedAt: string
  updatedBy?: string
}

/** O que a máscara pegou (sem o valor). */
export interface ISecretHit {
  at: string
  layer: 'value' | 'shape' | 'format'
  label: string
  field?: string
  length: number
}

export interface ISecretNames {
  secret: string[]
  safe: string[]
}

export interface ISecretMask {
  values: ISecretValue[]
  names: ISecretNames
  hits: ISecretHit[]
}

/**
 * A máscara de segredos (só admin; um dado só, chave `''`). ⚖️ Os acertos mudam a cada comando: relidos depois de 30 s
 * ao voltar à tela, e depois de cada teste. Gravar um valor não devolve a lista: relê; os nomes e a remoção, não.
 */
export const useSecretsStore = defineStore('secrets', () => {
  const mask = keyedResource(() => api<ISecretMask>('/secret-mask'), { staleMs: 30_000 })

  async function saveValue(id: string, label: string, value: string): Promise<void> {
    await api(`/secret-mask/values/${encodeURIComponent(id)}`, { method: 'PUT', body: { label, value } })
    await mask.refresh('').catch(() => undefined)
  }

  async function removeValue(id: string): Promise<void> {
    await api(`/secret-mask/values/${encodeURIComponent(id)}`, { method: 'DELETE' })
    mask.update('', (current) => ({ ...current, values: current.values.filter((value) => value.id !== id) }))
  }

  async function saveNames(names: ISecretNames): Promise<void> {
    const saved = await api<ISecretNames>('/secret-mask/names', { method: 'PUT', body: names })
    mask.update('', (current) => ({ ...current, names: saved }))
  }

  /** Como um texto sai mascarado. O teste conta como acerto: relê a lista deles. */
  async function test(text: string): Promise<string> {
    const { masked } = await api<{ masked: string }>('/secret-mask/test', { method: 'POST', body: { text } })
    void mask.refresh('').catch(() => undefined)
    return masked
  }

  return { mask, saveValue, removeValue, saveNames, test }
})
