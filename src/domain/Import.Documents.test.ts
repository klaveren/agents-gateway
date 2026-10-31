import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentDocument } from './Catalog.Document'
import { EMode } from './enums/EMode.Enum'
import { importDocuments, importedRuleId, IImportDocumentsInput } from './Import.Documents'
import { applyImportOps, IImportDraft, TImportDraftKind, TImportOp } from './Import.Draft'

/** Um rascunho de verdade: as operações aplicadas sobre a fonte. */
function draft(key: string, kind: TImportDraftKind, text: string, ops: TImportOp[]): IImportDraft {
  const result = applyImportOps(kind, [{ path: 'f.md', text }], ops)
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues))
  return { key, kind, sources: [{ path: 'f.md', sha256: 'x' }], ops, ...result.applied, conversationId: 'c', proposedAt: '2026-10-30T12:00:00.000Z' }
}
const meta = (values: Record<string, string>): TImportOp[] => Object.entries(values).map(([field, value]) => ({ op: 'setMeta', field, value }))

const base: Omit<IImportDocumentsInput, 'entries'> = {
  projectId: 'alfa',
  current: () => undefined,
  ruleByTitle: () => undefined,
  ruleCount: () => 2,
  agentIdOf: () => undefined,
  agent: () => ({ allowedTools: [], permissions: [], skills: [], commands: [] }),
}

describe('importDocuments', () => {
  it('split vira outro item do mesmo tipo; reference vai em docIds e docRefs; scope global sai sem projeto', () => {
    const text = '# Guia\nVer `docs/a.md`.\n## Anexo\nOutra parte.\n'
    const spec = draft('spec:guia', 'spec', text, [
      { op: 'linkCitation', text: 'docs/a.md', target: 'doc-a', link: 'reference' },
      { op: 'split', text: '## Anexo', meta: { id: 'guia-anexo', title: 'Anexo', summary: 'S' } },
      ...meta({ id: 'guia', title: 'Guia', summary: 'S', scope: 'global' }),
    ])
    const { documents, produced } = importDocuments({ ...base, entries: [{ key: 'spec:guia', kind: 'spec', draft: spec }] })
    assert.deepStrictEqual(produced['spec:guia'], ['spec/guia', 'spec/guia-anexo'])
    const [main, part] = documents
    assert.deepStrictEqual([main.projectId, main.body.docIds, main.body.docRefs, main.body.body], [undefined, ['doc-a'], ['doc-a'], '# Guia\nVer `doc-a`.'])
    assert.deepStrictEqual([part.projectId, part.body.body, part.body.docIds], ['alfa', '## Anexo\nOutra parte.', []])
  })

  it('rule nova: id estável do escopo e do título, no fim da lista; a do mesmo título é atualizada', () => {
    const rule = draft('rule:a', 'rule', 'Corpo.\n', meta({ title: 'A' }))
    const fresh = importDocuments({ ...base, entries: [{ key: 'rule:a', kind: 'rule', draft: rule }] }).documents[0]
    assert.deepStrictEqual([fresh.id, fresh.body.position, fresh.body.enabled], [importedRuleId('alfa', 'A'), 3, true])
    const existing = { ...fresh, id: 'r-1', body: { ...fresh.body, id: 'r-1', position: 1, enabled: false } }
    const updated = importDocuments({ ...base, ruleByTitle: () => existing, entries: [{ key: 'rule:a', kind: 'rule', draft: rule }] }).documents[0]
    assert.deepStrictEqual([updated.id, updated.body.position, updated.body.enabled], ['r-1', 1, false])
  })

  it('trigger cujo agente já existe no catálogo entra nele (os outros triggers ficam); sem agente, fica de fora', () => {
    const trigger = draft('trigger:maya/novo', 'trigger', 'Faça X.\n', meta({ id: 'novo', when: 'pedirem X' }))
    const maya = agentDocument(
      {
        id: 'maya',
        name: 'Maya',
        providers: [{ provider: 'google', models: ['m'] }],
        systemPrompt: 'P',
        modes: [EMode.CHAT],
        allowedTools: [],
        triggers: [{ id: 'velho', when: 'w', body: 'b' }],
      },
      { resources: { skills: [], commands: [] }, initialContext: [] },
    )
    const entries = [{ key: 'trigger:maya/novo', kind: 'trigger' as const, parent: 'agent:maya', draft: trigger }]
    const merged = importDocuments({ ...base, entries, agentIdOf: () => 'maya', current: (kind, id) => (kind === 'agent' && id === 'maya' ? maya : undefined) })
    assert.deepStrictEqual(merged.produced['trigger:maya/novo'], ['agent/maya'])
    assert.deepStrictEqual(merged.documents[0].body.triggers, [
      { id: 'velho', when: 'w', body: 'b' },
      { id: 'novo', when: 'pedirem X', body: 'Faça X.' },
    ])
    const alone = importDocuments({ ...base, entries })
    assert.deepStrictEqual([alone.documents, alone.skipped.map((item) => item.key)], [[], ['trigger:maya/novo']])
  })

  it('o agente leva SÓ o alcance que vem pronto (nasce fechado por quem chama), o modelo escolhido e as skills que libera', () => {
    const agent = draft('agent:maya', 'agent', 'Você é a Maya.\n', meta({ id: 'maya', name: 'Maya' }))
    const { documents } = importDocuments({
      ...base,
      entries: [{ key: 'agent:maya', kind: 'agent', draft: agent }],
      agent: () => ({ providers: [{ provider: 'google', models: ['m'] }], allowedTools: [], permissions: [], skills: ['revisar'], commands: [] }),
    })
    const body = documents[0].body
    assert.deepStrictEqual(
      [body.allowedTools, body.permissions, body.modes, body.resources, body.projectId],
      [[], undefined, ['chat'], { skills: ['revisar'], commands: [] }, 'alfa'],
    )
  })
})
