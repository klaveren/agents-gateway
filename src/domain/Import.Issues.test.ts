import assert from 'node:assert'
import { describe, it } from 'node:test'
import { withBody } from './Catalog.Import'
import { ILinkWorld, restoreImportLinks, withImportIssues } from './Import.Issues'

const world = (overrides: Partial<ILinkWorld> = {}): ILinkWorld => ({
  projectId: 'alfa',
  writtenDocs: new Map([['arq', 'spec']]),
  writtenResources: new Map([['revisar', 'skill']]),
  catalogDoc: (id) => ({ adr1: { kind: 'adr' }, beta: { kind: 'spec', projectId: 'beta' } })[id],
  catalogResource: () => undefined,
  pendingDoc: (id) => id === 'depois',
  otherKind: (id) => (id === 'pm' ? 'agent' : undefined),
  ...overrides,
})

describe('Import.Issues — os vínculos que não bloqueiam', () => {
  it('o agente: contexto inicial só com spec do escopo; a skill que falta sai de `resources` e vira problema', () => {
    const agent = withBody(
      { kind: 'agent', id: 'maya', projectId: 'alfa' },
      { id: 'maya', projectId: 'alfa', initialContext: ['arq', 'adr1', 'beta', 'depois'], resources: { skills: ['revisar', 'falta'], commands: ['*'] } },
    )
    const out = withImportIssues(agent, world())
    assert.deepStrictEqual(out.body.initialContext, ['arq'])
    assert.deepStrictEqual(out.body.resources, { skills: ['revisar'], commands: ['*'] })
    assert.deepStrictEqual(
      (out.body.importIssues as Array<{ code: string; target: string }>).map((one) => [one.code, one.target]),
      [
        ['link-not-spec', 'adr1'],
        ['link-scope', 'beta'],
        ['link-pending', 'depois'],
        ['skill-missing', 'falta'],
      ],
    )
  })

  it('sem problema, o documento não ganha `importIssues` (o hash fica o mesmo)', () => {
    const doc = withBody({ kind: 'spec', id: 'guia', projectId: 'alfa' }, { id: 'guia', projectId: 'alfa', docIds: ['arq'], docRefs: ['arq'] })
    assert.strictEqual(withImportIssues(doc, world()).hash, doc.hash)
  })

  it('a volta: o vínculo no fim da lista (e em `docRefs`, se era por referência); com `*`, só o problema sai', () => {
    const issues = [
      { code: 'link-pending', message: 'x', target: 'depois', link: 'reference' },
      { code: 'link-missing', message: 'y', target: 'nada', link: 'attach' },
    ]
    const doc = withBody({ kind: 'spec', id: 'guia', projectId: 'alfa' }, { id: 'guia', projectId: 'alfa', docIds: ['arq'], importIssues: issues })
    const back = restoreImportLinks(doc, { docs: new Set(['depois']), skills: new Set(), commands: new Set() })!
    assert.deepStrictEqual([back.body.docIds, back.body.docRefs, back.body.importIssues], [['arq', 'depois'], ['depois'], [issues[1]]])
    assert.strictEqual(restoreImportLinks(doc, { docs: new Set(['nada']), skills: new Set(), commands: new Set() }), undefined)

    const agent = withBody(
      { kind: 'agent', id: 'maya', projectId: 'alfa' },
      { id: 'maya', resources: { skills: ['*'], commands: [] }, importIssues: [{ code: 'skill-missing', message: 'z', target: 'revisar', link: 'skill' }] },
    )
    const granted = restoreImportLinks(agent, { docs: new Set(), skills: new Set(['revisar']), commands: new Set() })!
    assert.deepStrictEqual([granted.body.resources, granted.body.importIssues], [{ skills: ['*'], commands: [] }, undefined])
  })
})
