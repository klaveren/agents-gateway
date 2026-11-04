import { describe, expect, it } from 'vitest'
import { DOC_STATUS_LABEL, DOC_STATUSES, docStatusOf, filterByStatus, isInactive, sameIds, statusCounts } from './docStatus'

describe('docStatusOf', () => {
  it('ausente = aceita', () => {
    expect(docStatusOf({})).toBe('accepted')
    expect(docStatusOf({ status: 'superseded' })).toBe('superseded')
  })
})

describe('isInactive', () => {
  it('só substituída e arquivada saem do índice', () => {
    expect(DOC_STATUSES.filter(isInactive)).toEqual(['superseded', 'archived'])
  })
})

describe('rótulos', () => {
  it('um para cada status', () => {
    expect(DOC_STATUSES.map((status) => DOC_STATUS_LABEL[status])).toEqual(['proposta', 'aceita', 'substituída', 'arquivada'])
  })
})

describe('statusCounts e filterByStatus', () => {
  const docs = [{ id: 'a' }, { id: 'b', status: 'accepted' as const }, { id: 'c', status: 'proposed' as const }, { id: 'd', status: 'archived' as const }]

  it('conta com o ausente como aceita', () => {
    expect(statusCounts(docs)).toEqual({ all: 4, accepted: 2, proposed: 1, superseded: 0, archived: 1 })
  })

  it('filtra por status; "all" deixa todos', () => {
    expect(filterByStatus(docs, 'accepted').map((doc) => doc.id)).toEqual(['a', 'b'])
    expect(filterByStatus(docs, 'superseded')).toEqual([])
    expect(filterByStatus(docs, 'all')).toHaveLength(4)
  })
})

describe('sameIds', () => {
  it('ignora a ordem e trata ausente como vazia', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameIds(undefined, [])).toBe(true)
    expect(sameIds(['a'], [])).toBe(false)
  })
})
