import { computed, type ComputedRef, type MaybeRefOrGetter, toValue, watch } from 'vue'
import type { IKeyedResource } from '@/lib/resource'

export interface IUseResource<T> {
  /** O dado da chave atual, da store (reativo: muda em todas as telas juntas). */
  data: ComputedRef<T | undefined>
  /** A primeira leitura da chave ainda não voltou. */
  loading: ComputedRef<boolean>
  error: ComputedRef<unknown>
  /** Busca de novo (o botão "Atualizar"). */
  refresh: () => Promise<T | undefined>
}

/**
 * O lado da TELA de um `keyedResource`: lê da store pela chave (uma ref, getter ou valor) e garante a leitura quando a
 * chave muda — sem repetir o que a store já tem. Chave ausente (`undefined`): nada a ler.
 *
 *   const docs = useDocsStore()
 *   const { data: list, loading } = useResource(docs.lists, () => scope.value)
 */
export function useResource<T>(resource: IKeyedResource<T>, key: MaybeRefOrGetter<string | undefined>): IUseResource<T> {
  const current = computed(() => toValue(key))
  watch(
    current,
    (value) => {
      if (value !== undefined) void resource.ensure(value).catch(() => undefined)
    },
    { immediate: true },
  )
  return {
    data: computed(() => (current.value === undefined ? undefined : resource.get(current.value))),
    loading: computed(() => current.value !== undefined && !resource.has(current.value) && resource.loading(current.value)),
    error: computed(() => (current.value === undefined ? undefined : resource.error(current.value))),
    refresh: async () => (current.value === undefined ? undefined : resource.refresh(current.value)),
  }
}
