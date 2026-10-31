import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { IImportDraftView } from '@/lib/importDraft'
import ImportItemReview from './ImportItemReview.vue'

const DRAFT: IImportDraftView = {
  key: 'spec:arquitetura',
  kind: 'spec',
  sources: [{ path: '.agents/specs/arquitetura.md', sha256: 'a'.repeat(64) }],
  ops: [
    { op: 'remove', text: 'Última revisão: 2025-12-02\n', reason: 'carimbo de histórico' },
    { op: 'linkCitation', text: '.agents/specs/filas.md', target: 'filas', link: 'attach' },
    { op: 'remove', text: '<!-- gerado -->\n', reason: 'cabeçalho de gerado' },
    { op: 'setMeta', field: 'id', value: 'arquitetura' },
  ],
  meta: { id: 'arquitetura', title: 'Arquitetura', summary: 'As camadas.' },
  outputs: [{ from: 'main', meta: { id: 'arquitetura' }, fields: { body: '# Arquitetura' } }],
  links: [{ op: 1, source: '.agents/specs/arquitetura.md', text: '.agents/specs/filas.md', target: 'filas', link: 'attach' }],
  removals: [
    { op: 0, source: '.agents/specs/arquitetura.md', text: 'Última revisão: 2025-12-02\n', whole: false, reason: 'carimbo de histórico' },
    { op: 2, source: '.agents/specs/arquitetura.md', text: '<!-- gerado -->\n', whole: false, reason: 'cabeçalho de gerado' },
  ],
  diffs: [
    {
      source: '.agents/specs/arquitetura.md',
      diff: {
        equal: false,
        added: 1,
        removed: 2,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 2,
            lines: [
              { op: 'remove', text: '<!-- gerado -->', oldLine: 1 },
              { op: 'equal', text: '# Arquitetura', oldLine: 2, newLine: 1 },
              { op: 'remove', text: 'Leia `.agents/specs/filas.md`.', oldLine: 3 },
              { op: 'add', text: 'Leia `filas`.', newLine: 2 },
            ],
          },
        ],
      },
    },
  ],
  conversationId: 'c1',
  proposedAt: '2026-10-30T12:00:00.000Z',
}

async function mount(props: Record<string, unknown> = {}) {
  const events: Array<[string, unknown]> = []
  const host = document.createElement('div')
  document.body.append(host)
  createApp({
    render: () =>
      h(ImportItemReview, {
        draft: DRAFT,
        state: 'review',
        ...props,
        onApprove: (oks: number[]) => events.push(['approve', oks]),
        onAdjust: (comment: string) => events.push(['adjust', comment]),
      }),
  }).mount(host)
  await nextTick()
  return { host, events }
}

const click = async (element: Element | null) => {
  ;(element as HTMLElement).click()
  await nextTick()
}

describe('ImportItemReview', () => {
  it('mostra os metadados, as operações com as remoções em destaque, os vínculos e o diff fonte × final', async () => {
    const { host } = await mount()
    expect(host.querySelector('[data-test="draft-meta"]')!.textContent).toContain('Arquitetura')
    const removals = host.querySelectorAll('[data-test="removal"]')
    expect(removals).toHaveLength(2)
    expect(removals[0].textContent).toContain('carimbo de histórico')
    expect(removals[0].textContent).toContain('Última revisão')
    expect(host.querySelectorAll('[data-test="op"]')).toHaveLength(2)
    expect(host.querySelector('[data-test="draft-links"]')!.textContent).toContain('filas')
    expect(host.querySelectorAll('[data-test="diff-remove"]')).toHaveLength(2)
    expect(host.querySelector('[data-test="diff-add"]')!.textContent).toBe('+Leia `filas`.')
  })

  it('⛔ aprovar só com OK em TODA remoção; o evento leva os índices das operações', async () => {
    const { host, events } = await mount()
    const approve = host.querySelector<HTMLButtonElement>('[data-test="approve"]')!
    expect(approve.disabled).toBe(true)
    expect(host.querySelector('[data-test="missing"]')!.textContent).toContain('2')
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-test="removal-ok"]')
    await click(boxes[0])
    expect(approve.disabled).toBe(true)
    await click(boxes[1])
    expect(approve.disabled).toBe(false)
    expect(host.querySelector('[data-test="missing"]')).toBeNull()
    await click(approve)
    expect(events).toEqual([['approve', [0, 2]]])
  })

  it('pedir ajuste manda o comentário para a conversa', async () => {
    const { host, events } = await mount()
    await click(host.querySelector('[data-test="adjust"]'))
    const text = host.querySelector<HTMLTextAreaElement>('[data-test="adjust-comment"]')!
    text.value = 'mantenha o cabeçalho'
    text.dispatchEvent(new Event('input'))
    await nextTick()
    host.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'))
    await nextTick()
    expect(events).toEqual([['adjust', 'mantenha o cabeçalho']])
  })

  it('fora de review (ou em trabalho antigo) não há caixas habilitadas nem botões; aprovado diz que nada foi ao catálogo', async () => {
    const readonly = await mount({ readonly: true })
    expect(readonly.host.querySelector('[data-test="approve"]')).toBeNull()
    expect([...readonly.host.querySelectorAll<HTMLInputElement>('[data-test="removal-ok"]')].every((box) => box.disabled)).toBe(true)
    const approved = await mount({ state: 'approved', approvedBy: 'ana', review: { removals: [0, 2] } })
    expect(approved.host.querySelector('[data-test="approved"]')!.textContent).toContain('Nada foi ao catálogo')
    expect([...approved.host.querySelectorAll<HTMLInputElement>('[data-test="removal-ok"]')].every((box) => box.checked)).toBe(true)
    const adjusting = await mount({ state: 'drafting', review: { adjust: { comment: 'divida', by: 'ana', at: '2026-10-30T12:00:00.000Z' } } })
    expect(adjusting.host.querySelector('[data-test="adjust-pending"]')!.textContent).toContain('divida')
  })
})
