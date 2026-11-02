import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { IImportItemStatus, IInventoryItem } from '@/lib/importer'
import ImportBatchProgress from './ImportBatchProgress.vue'

const item = (key: string): IInventoryItem =>
  ({ key, kind: key.split(':')[0], candidateId: key.split(':')[1], detectors: [], sources: [], refs: [], unresolved: [], notes: [] }) as unknown as IInventoryItem

async function mount(statuses: Record<string, Partial<IImportItemStatus> & { conversationId?: string }>) {
  const keys = ['spec:guia', 'skill:deploy', 'agent:maya', 'mcp:github']
  const host = document.createElement('div')
  document.body.append(host)
  const events: string[] = []
  createApp({
    render: () =>
      h(ImportBatchProgress, {
        keys,
        items: new Map(keys.map((key) => [key, item(key)])),
        statuses: statuses as Record<string, IImportItemStatus>,
        overrides: {},
        onSelect: (key: string) => events.push(key),
        onConversation: (id: string) => events.push(`conversation:${id}`),
      }),
  }).mount(host)
  await nextTick()
  return { host, events }
}

describe('ImportBatchProgress — o passo Preparar do lote', () => {
  it('cada item com o estado e a conversa; o resumo conta por estado; o que não tem construtor diz isso', async () => {
    const { host, events } = await mount({
      'spec:guia': { key: 'spec:guia', state: 'review', conversationId: 'c1' },
      'skill:deploy': { key: 'skill:deploy', state: 'drafting', conversationId: 'c2' },
      'agent:maya': { key: 'agent:maya', state: 'approved', conversationId: 'c3' },
    })
    const rows = [...host.querySelectorAll('[data-test="progress-row"]')]
    expect(rows.map((row) => row.querySelector('[data-test="progress-state"]')!.textContent!.trim())).toEqual(['a revisar', 'no construtor', 'aprovado', 'a importar'])
    expect(rows[0].querySelector('[data-test="progress-conversation"]')!.textContent!.trim()).toBe('Revisar')
    expect(rows[1].querySelector('[data-test="progress-conversation"]')!.textContent!.trim()).toBe('Ver conversa')
    expect(rows[3].textContent).toContain('sem construtor')
    expect(host.querySelector('[data-test="progress-summary"]')!.textContent!.replace(/\s+/g, ' ')).toContain('no construtor 1')
    ;(rows[1].querySelector('button') as HTMLButtonElement).click()
    ;(rows[0].querySelector('[data-test="progress-conversation"]') as HTMLButtonElement).click()
    expect(events).toEqual(['skill:deploy', 'conversation:c1'])
  })
})
