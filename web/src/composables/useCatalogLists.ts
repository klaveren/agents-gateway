import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import type { IProjectDoc, IResource, TDocKind } from '@/lib/types'
import { useDocsStore } from '@/stores/docs'
import { useResourcesStore } from '@/stores/resources'
import { type IUseResource, useResource } from './useResource'

export interface IScopedList<T> {
  /** Os do projeto primeiro, depois os globais. */
  list: ComputedRef<T[]>
  loading: ComputedRef<boolean>
  error: ComputedRef<unknown>
}

/** Junta a lista do projeto e a global (as duas da store, lidas uma vez para todas as telas). */
function scoped<T>(globals: IUseResource<T[]>, local: IUseResource<T[]>): IScopedList<T> {
  return {
    list: computed(() => [...(local.data.value ?? []), ...(globals.data.value ?? [])]),
    loading: computed(() => globals.loading.value || local.loading.value),
    error: computed(() => globals.error.value ?? local.error.value),
  }
}

/**
 * Os documentos que um item do projeto dado vê: os globais e os do projeto (`null` = só os globais; `undefined` = nada a
 * ler — ainda não é admin). `kind` restringe o tipo (o contexto inicial só quer specs).
 */
export function useScopedDocs(project: MaybeRefOrGetter<string | null | undefined>, kind?: TDocKind): IScopedList<IProjectDoc> {
  const docs = useDocsStore()
  const globals = useResource(docs.lists, () => (toValue(project) === undefined ? undefined : docs.listKey(GLOBAL_SCOPE, kind)))
  const local = useResource(docs.lists, () => {
    const id = toValue(project)
    return id ? docs.listKey(id, kind) : undefined
  })
  return scoped(globals, local)
}

/** As skills e os commands que um agente do projeto dado vê: os globais e os do projeto (`null` = só os globais). */
export function useScopedResources(project: MaybeRefOrGetter<string | null | undefined>): IScopedList<IResource> {
  const resources = useResourcesStore()
  const globals = useResource(resources.lists, () => (toValue(project) === undefined ? undefined : resources.listKey(GLOBAL_SCOPE)))
  const local = useResource(resources.lists, () => {
    const id = toValue(project)
    return id ? resources.listKey(id) : undefined
  })
  return scoped(globals, local)
}
