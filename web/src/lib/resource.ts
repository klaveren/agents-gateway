import { shallowRef, triggerRef } from 'vue'

/**
 * UM DADO DO SERVIDOR GUARDADO POR CHAVE (o projeto, o id do agente…), para usar DENTRO de uma store Pinia: todo GET
 * que a tela faz mora numa store, e todas as telas leem a mesma cópia, reativa.
 *
 * - `ensure(key)`: devolve o que já tem; só busca se ainda não tem (ou se passou de `staleMs`). Quem pede enquanto a
 *   busca não volta espera a MESMA busca — duas telas abrindo juntas fazem uma chamada só.
 * - `refresh(key)`: busca de novo (o botão "Atualizar", a volta à aba, o aviso do servidor).
 * - `set`/`update`/`drop`: a gravação põe a resposta do servidor na store, sem reler a lista inteira.
 * - `refreshLoaded()`: busca de novo tudo o que já foi lido (o que outra pessoa mudou aparece).
 *
 * Chave única (um dado só, sem chave): use `''`.
 */
export interface IKeyedResource<T> {
  /** O dado da chave, reativo (ausente: ainda não lido). */
  get(key: string): T | undefined
  /** Já foi lido (mesmo vazio)? */
  has(key: string): boolean
  /** A chave tem uma busca em curso? */
  loading(key: string): boolean
  /** O erro da última busca da chave (some quando uma busca dá certo). */
  error(key: string): unknown
  ensure(key: string): Promise<T>
  refresh(key: string): Promise<T>
  set(key: string, data: T): void
  /** Muda o dado guardado (a gravação que devolve o item: troca na lista). Sem dado guardado, não faz nada. */
  update(key: string, change: (current: T) => T): void
  drop(key: string): void
  clear(): void
  /** As chaves já lidas. */
  keys(): string[]
  refreshLoaded(): Promise<void>
}

interface IEntry<T> {
  data?: T
  has: boolean
  at?: number
  pending?: Promise<T>
  error?: unknown
}

export interface IKeyedResourceOptions {
  /** Depois deste tempo o `ensure` busca de novo. Padrão: nunca (só o `refresh`). */
  staleMs?: number
  now?: () => number
}

/** Todos os recursos criados: o logout esquece todos de uma vez (`clearResources`), sem cada store lembrar de si. */
const created = new Set<IKeyedResource<unknown>>()

/** ⛔ Esquece o que todas as stores leram (o logout): quem entra depois no mesmo navegador não vê os dados do anterior. */
export function clearResources(): void {
  for (const resource of created) resource.clear()
}

export function keyedResource<T>(fetcher: (key: string) => Promise<T>, options: IKeyedResourceOptions = {}): IKeyedResource<T> {
  const entries = shallowRef(new Map<string, IEntry<T>>())
  const now = options.now ?? Date.now
  const entry = (key: string) => entries.value.get(key)
  const write = (key: string, patch: Partial<IEntry<T>>) => {
    entries.value.set(key, { has: false, ...entries.value.get(key), ...patch })
    triggerRef(entries)
  }
  // ⚖️ A geração: um `refresh` (ou `drop`) no meio de uma busca faz a resposta velha não sobrescrever a nova.
  const generation = new Map<string, number>()

  function fetchKey(key: string): Promise<T> {
    const mine = (generation.get(key) ?? 0) + 1
    generation.set(key, mine)
    const pending = fetcher(key).then(
      (data) => {
        if (generation.get(key) === mine) write(key, { data, has: true, at: now(), pending: undefined, error: undefined })
        return data
      },
      (error: unknown) => {
        if (generation.get(key) === mine) write(key, { pending: undefined, error })
        throw error
      },
    )
    write(key, { pending })
    return pending
  }

  const fresh = (current: IEntry<T>) => current.has && (options.staleMs === undefined || now() - (current.at ?? 0) < options.staleMs)

  const resource: IKeyedResource<T> = {
    get: (key) => entry(key)?.data,
    has: (key) => !!entry(key)?.has,
    loading: (key) => !!entry(key)?.pending,
    error: (key) => entry(key)?.error,
    ensure(key) {
      const current = entry(key)
      if (current?.pending) return current.pending
      if (current && fresh(current)) return Promise.resolve(current.data as T)
      return fetchKey(key)
    },
    refresh: (key) => fetchKey(key),
    set: (key, data) => {
      generation.set(key, (generation.get(key) ?? 0) + 1)
      write(key, { data, has: true, at: now(), pending: undefined, error: undefined })
    },
    update(key, change) {
      const current = entry(key)
      if (!current?.has) return
      write(key, { data: change(current.data as T) })
    },
    drop(key) {
      generation.set(key, (generation.get(key) ?? 0) + 1)
      entries.value.delete(key)
      triggerRef(entries)
    },
    clear() {
      for (const key of entries.value.keys()) generation.set(key, (generation.get(key) ?? 0) + 1)
      entries.value = new Map()
    },
    keys: () => [...entries.value.entries()].filter(([, value]) => value.has).map(([key]) => key),
    async refreshLoaded() {
      const loaded = [...entries.value.entries()].filter(([, value]) => value.has).map(([key]) => key)
      await Promise.all(loaded.map((key) => fetchKey(key).catch(() => undefined)))
    },
  }
  created.add(resource as IKeyedResource<unknown>)
  return resource
}
