import { defineStore } from 'pinia'
import { shallowRef, triggerRef } from 'vue'
import { api } from '@/lib/api'
import type { IApplyResult } from '@/lib/importApply'
import type { IImportBatchRun, IImportBuildStatus } from '@/lib/importDraft'
import type { IImportAnalysis, IImportBatch, IImportBatchView, IImportItemStatus, IImportJob, IImportJobSummary, TImportItemState, TInventoryKind } from '@/lib/importer'
import { keyedResource } from '@/lib/resource'

/** O trabalho aberto, sem os estados dos itens: eles moram numa cópia só, em `statesOf`. */
export type IImportJobView = Omit<IImportJob, 'states'>

/** As chaves das leituras: o projeto e o trabalho (e o lote), num texto. */
export const jobKey = (projectId: string, jobId: string) => `${projectId}\n${jobId}`
export const batchKey = (projectId: string, jobId: string, batchId: string) => `${projectId}\n${jobId}\n${batchId}`

/** O servidor lê no máximo 200 chaves por pedido. */
const KEYS_PER_CALL = 200
const EMPTY: Readonly<Record<string, IImportBuildStatus>> = Object.freeze({})

const importPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/import`
const jobPath = (projectId: string, jobId: string) => `${importPath(projectId)}/jobs/${encodeURIComponent(jobId)}`
const batchPath = (projectId: string, jobId: string, batchId: string) => `${jobPath(projectId, jobId)}/batches/${encodeURIComponent(batchId)}`
const split = (key: string) => key.split('\n') as [string, string, string]

/**
 * O IMPORTADOR (só admin), por projeto: os trabalhos, o trabalho aberto, os lotes (lista e cada um), as conversas de
 * cada lote e o ignorar. E o ESTADO DE CADA ITEM, numa cópia só por trabalho e chave do item — o Importador, a fila de
 * revisão (`ImportDraftAside`, também na tela do construtor) e a mesa do Preparar leem a mesma, e a revisão feita numa
 * aparece nas outras.
 *
 * ⚖️ Duas fontes para o estado do item:
 * - o trabalho (`GET …/jobs/:job`) traz o estado LEVE (sem rascunho nem revisão, só `drafted`);
 * - `GET …/items?keys=` traz o COMPLETO (com os rascunhos), e as gravações da revisão devolvem o item completo.
 * O leve não apaga o rascunho que já veio; mas, se o item mudou depois (outra hora), ele deixa de contar como completo
 * e a próxima `ensureItems` o busca de novo. O completo substitui (não mescla): a conversa de que o item saiu não vem.
 */
export const useImportsStore = defineStore('imports', () => {
  // ── O estado dos itens ─────────────────────────────────────────────────────

  /** ⚖️ `shallowRef`: centenas de itens com rascunhos grandes; cada registro é trocado inteiro, nunca mexido por dentro. */
  const states = shallowRef(new Map<string, Readonly<Record<string, IImportBuildStatus>>>())
  const latest = shallowRef(new Map<string, boolean>())
  /** Fora da reatividade: o que já veio completo, a busca em curso de cada item e a versão (a gravação mais nova vence). */
  const full = new Map<string, Set<string>>()
  const pending = new Map<string, Map<string, Promise<void>>>()
  const version = new Map<string, Map<string, number>>()

  const inner = <T>(map: Map<string, T>, key: string, make: () => T): T => {
    let found = map.get(key)
    if (!found) map.set(key, (found = make()))
    return found
  }
  const bump = (key: string, keys: Iterable<string>) => {
    const versions = inner(version, key, () => new Map<string, number>())
    for (const one of keys) versions.set(one, (versions.get(one) ?? 0) + 1)
  }

  function write(key: string, change: (record: Record<string, IImportBuildStatus>) => void) {
    const record = { ...(states.value.get(key) ?? {}) }
    change(record)
    states.value.set(key, record)
    triggerRef(states)
    recount(key)
  }

  /** O estado leve do trabalho: troca o que veio, guardando o rascunho já lido (enquanto o item não mudou). */
  function mergeLean(key: string, lean: readonly IImportItemStatus[], fresh?: boolean) {
    const done = inner(full, key, () => new Set<string>())
    // ⚖️ Sem `bump`: o completo que ainda está a caminho sabe mais que o leve (traz o rascunho) e pode passar por cima.
    write(key, (record) => {
      for (const one of lean) {
        const before = record[one.key]
        const kept = one.drafted && before?.drafts ? { drafts: before.drafts, ...(before.review ? { review: before.review } : {}) } : {}
        record[one.key] = { ...one, ...kept }
        // Sem rascunho, o leve já é o item inteiro; com rascunho, só vale o guardado se nada mudou desde então.
        if (!one.drafted || (done.has(one.key) && before?.at === one.at)) done.add(one.key)
        else done.delete(one.key)
      }
    })
    if (fresh !== undefined) setLatest(key, fresh)
  }

  /** O estado completo (o `…/items` ou a resposta de uma gravação): substitui o item. */
  function putFull(key: string, list: readonly IImportBuildStatus[]) {
    const done = inner(full, key, () => new Set<string>())
    write(key, (record) => {
      for (const one of list) {
        record[one.key] = { ...one, drafted: !!one.drafts?.length }
        done.add(one.key)
      }
    })
  }

  function setLatest(key: string, value: boolean) {
    if (latest.value.get(key) === value) return
    latest.value.set(key, value)
    triggerRef(latest)
  }

  /** As contagens da linha do trabalho na lista, refeitas do estado dos itens — só com o trabalho inteiro lido. */
  function recount(key: string) {
    const [projectId, jobId] = split(key)
    if (!job.has(key) || !jobs.has(projectId)) return
    const counts: Partial<Record<TImportItemState, number>> = {}
    for (const entry of Object.values(states.value.get(key) ?? {})) counts[entry.state] = (counts[entry.state] ?? 0) + 1
    jobs.update(projectId, (list) => list.map((entry) => (entry.id === jobId ? { ...entry, byState: counts } : entry)))
  }

  /** Busca o completo das chaves, em pedaços; a resposta não passa por cima de uma gravação feita no meio. */
  function fetchItems(projectId: string, jobId: string, keys: readonly string[]): Promise<void> {
    const key = jobKey(projectId, jobId)
    const versions = inner(version, key, () => new Map<string, number>())
    const asked = new Map(keys.map((one) => [one, versions.get(one) ?? 0]))
    const running = inner(pending, key, () => new Map<string, Promise<void>>())
    const work = (async () => {
      let fresh = true
      for (let at = 0; at < keys.length; at += KEYS_PER_CALL) {
        const found = await api<{ latest: boolean; states: IImportBuildStatus[] }>(`${jobPath(projectId, jobId)}/items`, { query: { keys: keys.slice(at, at + KEYS_PER_CALL) } })
        fresh &&= found.latest
        putFull(
          key,
          found.states.filter((one) => asked.get(one.key) === (versions.get(one.key) ?? 0)),
        )
      }
      setLatest(key, fresh)
    })()
    const settle = work.finally(() => {
      for (const one of keys) if (running.get(one) === settle) running.delete(one)
    })
    for (const one of keys) running.set(one, settle)
    return settle
  }

  /** O estado reativo dos itens do trabalho (vazio enquanto nada foi lido). */
  function statesOf(projectId: string, jobId: string): Readonly<Record<string, IImportBuildStatus>> {
    return states.value.get(jobKey(projectId, jobId)) ?? EMPTY
  }

  /** O trabalho é o mais novo do repositório (só ele muda)? Ausente: ainda não se sabe. */
  function latestOf(projectId: string, jobId: string): boolean | undefined {
    return latest.value.get(jobKey(projectId, jobId))
  }

  /**
   * Garante o estado COMPLETO das chaves: busca só as que ainda não vieram completas; quem pede uma chave que já está
   * sendo buscada espera a mesma busca (duas telas abrindo juntas fazem uma chamada só).
   */
  async function ensureItems(projectId: string, jobId: string, keys: readonly string[]): Promise<void> {
    const key = jobKey(projectId, jobId)
    const done = full.get(key)
    const running = pending.get(key)
    const waiting = new Set<Promise<void>>()
    const missing: string[] = []
    for (const one of keys) {
      const inFlight = running?.get(one)
      if (inFlight) waiting.add(inFlight)
      else if (!done?.has(one)) missing.push(one)
    }
    if (missing.length) waiting.add(fetchItems(projectId, jobId, missing))
    await Promise.all(waiting)
  }

  /** Busca de novo o estado das chaves (o "Atualizar estados", a proposta que terminou, a volta do andamento). */
  function refreshItems(projectId: string, jobId: string, keys: readonly string[]): Promise<void> {
    return keys.length ? fetchItems(projectId, jobId, keys) : Promise.resolve()
  }

  /** Grava a resposta (o item completo) por cima de tudo, e devolve como ficou. */
  function keep(projectId: string, jobId: string, updated: IImportBuildStatus): IImportBuildStatus {
    const key = jobKey(projectId, jobId)
    bump(key, [updated.key])
    putFull(key, [updated])
    return statesOf(projectId, jobId)[updated.key]
  }

  // ── As leituras ────────────────────────────────────────────────────────────

  /** Os trabalhos do projeto, do mais novo ao mais velho (a chave é o projeto). */
  const jobs = keyedResource((projectId) => api<IImportJobSummary[]>(`${importPath(projectId)}/jobs`))
  /** O trabalho aberto (`jobKey`): o inventário; os estados vão para `statesOf`. */
  const job = keyedResource(async (key): Promise<IImportJobView> => {
    const [projectId, jobId] = split(key)
    const { states: lean, ...opened } = await api<IImportJob>(jobPath(projectId, jobId))
    mergeLean(key, lean, opened.latest)
    return opened
  })
  /** Os lotes salvos do trabalho (`jobKey`), do mais novo ao mais velho. */
  const batches = keyedResource((key) => {
    const [projectId, jobId] = split(key)
    return api<IImportBatch[]>(`${jobPath(projectId, jobId)}/batches`)
  })
  /** O lote salvo aberto (`batchKey`), com o lote recalculado sobre o estado da hora em que foi lido. */
  const batch = keyedResource((key) => {
    const [projectId, jobId, batchId] = split(key)
    return api<IImportBatchView>(batchPath(projectId, jobId, batchId))
  })
  /** As conversas de construtor do lote (`batchKey`) e o andamento: a mesa do Preparar relê enquanto alguma roda. */
  const runs = keyedResource(async (key) => {
    const [projectId, jobId, batchId] = split(key)
    return (await api<{ runs: IImportBatchRun[] }>(`${batchPath(projectId, jobId, batchId)}/conversations`)).runs
  })
  /** O ignorar do projeto: um padrão por linha (a chave é o projeto). */
  const ignore = keyedResource(async (projectId) => (await api<{ patterns: string[] }>(`${importPath(projectId)}/ignore`)).patterns)

  // ── As gravações ───────────────────────────────────────────────────────────

  /**
   * Analisa o repositório: a primeira vez cria a importação; depois reanalisa a MESMA (mesmo id), no lugar. A resposta
   * já traz tudo (inventário, estados de todos os itens, histórico): nenhuma leitura a mais. A importação vai ao topo
   * da lista (a mais recém-analisada primeiro).
   */
  async function analyze(projectId: string, repository: string): Promise<{ job: IImportJobView; analysis: IImportAnalysis }> {
    const { states: lean, analysis, ...created } = await api<IImportJob & { analysis: IImportAnalysis }>(`${importPath(projectId)}/jobs`, { method: 'POST', body: { repository } })
    const key = jobKey(projectId, created.id)
    job.set(key, created)
    const { scan: _scan, ...summary } = created
    jobs.update(projectId, (list) => [summary, ...list.filter((entry) => entry.id !== created.id && entry.repository !== created.repository)])
    mergeLean(key, lean, true)
    return { job: created, analysis }
  }

  /** Excluir/incluir e reclassificar um item (`kind: null` volta ao detectado). */
  async function updateItem(projectId: string, jobId: string, key: string, change: { state?: 'pending' | 'skipped'; kind?: TInventoryKind | null }): Promise<IImportBuildStatus> {
    return keep(projectId, jobId, await api<IImportBuildStatus>(`${jobPath(projectId, jobId)}/items`, { method: 'PATCH', body: { key, ...change } }))
  }

  /** Aprovar (com o OK de cada remoção) ou pedir ajuste do rascunho. ⛔ Não grava no catálogo. */
  async function review(projectId: string, jobId: string, key: string, action: 'approve' | 'adjust', body: { removals?: number[]; comment?: string }): Promise<IImportBuildStatus> {
    return keep(projectId, jobId, await api<IImportBuildStatus>(`${jobPath(projectId, jobId)}/items/${action}`, { method: 'POST', body: { key, ...body } }))
  }

  /** Gravou no catálogo: a resposta diz quais itens entraram — eles viram `applied`, com o lote do catálogo. */
  function markApplied(projectId: string, jobId: string, result: IApplyResult) {
    const key = jobKey(projectId, jobId)
    const current = statesOf(projectId, jobId)
    const keys = result.items.applied.filter((one) => current[one])
    if (!keys.length) return
    bump(key, keys)
    write(key, (record) => {
      for (const one of keys) record[one] = { ...record[one], state: 'applied', ...(result.batch ? { batchId: result.batch.id } : {}) }
    })
  }

  async function saveIgnore(projectId: string, patterns: string[]): Promise<string[]> {
    const result = await api<{ patterns: string[] }>(`${importPath(projectId)}/ignore`, { method: 'PUT', body: { patterns } })
    ignore.set(projectId, result.patterns)
    return result.patterns
  }

  /** Salva a seleção como lote: entra na lista e fica guardado aberto. ⛔ Não dispara nada nem grava no catálogo. */
  async function createBatch(projectId: string, jobId: string, body: { name: string; keys: string[]; prefix?: string }): Promise<IImportBatchView> {
    const view = await api<IImportBatchView>(`${jobPath(projectId, jobId)}/batches`, { method: 'POST', body })
    putBatch(projectId, jobId, view, true)
    return view
  }

  /** Acrescenta itens ao lote salvo (com as dependências, se pedido). */
  async function addToBatch(projectId: string, jobId: string, batchId: string, body: { keys: readonly string[]; closure?: boolean }): Promise<IImportBatchView> {
    const view = await api<IImportBatchView>(`${batchPath(projectId, jobId, batchId)}/items`, { method: 'POST', body })
    putBatch(projectId, jobId, view, false)
    return view
  }

  function putBatch(projectId: string, jobId: string, view: IImportBatchView, created: boolean) {
    const { plan: _plan, ...record } = view
    batch.set(batchKey(projectId, jobId, view.id), view)
    batches.update(jobKey(projectId, jobId), (list) =>
      created ? [record, ...list.filter((entry) => entry.id !== record.id)] : list.map((entry) => (entry.id === record.id ? record : entry)),
    )
  }

  /** "Preparar tudo": as conversas do lote vão ao construtor no servidor; a resposta traz o andamento de agora. */
  async function prepare(projectId: string, jobId: string, batchId: string, concurrency: number): Promise<IImportBatchRun[]> {
    const result = await api<{ runs: IImportBatchRun[] }>(`${batchPath(projectId, jobId, batchId)}/prepare`, { method: 'POST', body: { start: true, concurrency } })
    runs.set(batchKey(projectId, jobId, batchId), result.runs)
    return result.runs
  }

  /** O logout: esquece o estado dos itens (os recursos, o `clearResources` já esquece). */
  function reset(): void {
    states.value = new Map()
    latest.value = new Map()
    full.clear()
    pending.clear()
    version.clear()
  }

  return {
    reset,
    jobs,
    job,
    batches,
    batch,
    runs,
    ignore,
    statesOf,
    latestOf,
    ensureItems,
    refreshItems,
    analyze,
    updateItem,
    review,
    markApplied,
    saveIgnore,
    createBatch,
    addToBatch,
    prepare,
  }
})
