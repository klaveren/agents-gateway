import { defineStore } from 'pinia'
import { api, ApiError, authHeaders, url } from '@/lib/api'
import { contextKey, type ILedgerContext, type ILedgerIndex, type ILedgerLine, type ILedgerRevision, type ILedgerWriteResult, type TLedgerLineInput } from '@/lib/ledger'
import { keyedResource } from '@/lib/resource'

/**
 * O ledger de cada agente (só admin): o índice por agente (`indexes`, a chave é o id), o contexto inteiro e as revisões
 * por agente e tema (`contextKey`). ⚖️ Toda escrita devolve o índice e o contexto de depois: entram na store sem reler.
 * O histórico só é relido se já foi aberto. ⚖️ Sem `catalog.changed`: o ledger é dado de execução (o agente escreve no
 * meio da conversa); "Atualizar" relê.
 */
export const useLedgerStore = defineStore('ledger', () => {
  const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/ledger`
  const split = (key: string) => key.split('\u0000') as [string, string]
  const indexes = keyedResource((agentId) => api<ILedgerIndex>(base(agentId)))
  const contexts = keyedResource((key) => {
    const [agentId, topic] = split(key)
    return api<ILedgerContext>(`${base(agentId)}/contexts/${encodeURIComponent(topic)}`)
  })
  const revisions = keyedResource((key) => {
    const [agentId, topic] = split(key)
    return api<ILedgerRevision[]>(`${base(agentId)}/contexts/${encodeURIComponent(topic)}/revisions`)
  })

  /** A resposta da escrita na store: o índice, o contexto (ou a saída dele) e o histórico, se aberto. */
  function apply(agentId: string, result: ILedgerWriteResult): ILedgerWriteResult {
    indexes.set(agentId, result.index)
    const key = contextKey(agentId, result.topic)
    if (result.context) contexts.set(key, result.context)
    else contexts.drop(key)
    if (revisions.has(key)) void revisions.refresh(key).catch(() => undefined)
    return result
  }

  const write = async (agentId: string, path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
    apply(agentId, await api<ILedgerWriteResult>(`${base(agentId)}${path}`, { method, ...(body === undefined ? {} : { body }) }))
  const topicPath = (topic: string) => `/contexts/${encodeURIComponent(topic)}`

  const create = (agentId: string, input: { topic: string; trigger: string; playbook?: string }) => write(agentId, '/contexts', 'POST', input)
  const update = (agentId: string, topic: string, change: { trigger?: string; playbook?: string }) => write(agentId, topicPath(topic), 'PUT', change)
  const remove = (agentId: string, topic: string) => write(agentId, topicPath(topic), 'DELETE')
  const addLine = (agentId: string, topic: string, line: TLedgerLineInput) => write(agentId, `${topicPath(topic)}/lines`, 'POST', line)
  const updateLine = (agentId: string, topic: string, id: number, change: Partial<TLedgerLineInput>) => write(agentId, `${topicPath(topic)}/lines/${id}`, 'PUT', change)
  const removeLine = (agentId: string, topic: string, id: number) => write(agentId, `${topicPath(topic)}/lines/${id}`, 'DELETE')

  /** A busca nas linhas (e nos playbooks): lida na hora, não guardada. */
  function search(agentId: string, q: string): Promise<{ contexts: ILedgerIndex['contexts']; lines: Array<ILedgerLine & { topic: string }> }> {
    return api(`${base(agentId)}/search`, { query: { q } })
  }

  /** "Exportar": o `.tar.gz` com a pasta antiga (`<agente>-ledger/index.md` + `contextos/<tema>.md`), baixado pelo navegador. */
  async function download(agentId: string): Promise<void> {
    const response = await fetch(url(`${base(agentId)}/export`), { headers: authHeaders() })
    if (!response.ok) {
      const envelope = (await response.json().catch(() => undefined)) as { message?: string; code?: string } | undefined
      throw new ApiError(response.status, envelope?.code, envelope?.message ?? `HTTP ${response.status}`)
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `${agentId}-ledger.tar.gz`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(await response.blob())
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return { indexes, contexts, revisions, create, update, remove, addLine, updateLine, removeLine, search, download }
})
