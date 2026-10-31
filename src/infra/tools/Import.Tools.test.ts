import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IImportDraft } from '@domain/Import.Draft'
import { IImportDesk, makeImportTools } from './Import.Tools'
import { makeLocalTools } from './Local.Tools'
import { ToolCatalog } from './Tool.Catalog'

describe('Import.Tools — as ferramentas do construtor em modo importação', () => {
  const calls: string[] = []
  const desk: IImportDesk = {
    listText: (conversation) => (calls.push(`list:${conversation}`), 'itens'),
    readSource: (conversation, key, options) => (calls.push(`read:${conversation}:${key}:${JSON.stringify(options)}`), 'texto'),
    propose: (_conversation, key, _meta, ops) => {
      if (!Array.isArray(ops) || !ops.length) throw Object.assign(new Error('the draft has problems'), { issues: [{ field: 'ops[0].text', message: 'excerpt not found' }] })
      return { draft: { key, ops, removals: [{}], outputs: [{ meta: { id: 'x' } }] } as unknown as IImportDraft }
    },
  }
  const [list, read, propose] = makeImportTools(desk)
  const importer = { agentId: 'builder-import-spec', sessionId: 'c1' }

  it('⛔ só o construtor em modo importação, e só numa conversa', async () => {
    for (const context of [{ agentId: 'builder-spec', sessionId: 'c1' }, { agentId: 'atlas', sessionId: 'c1' }, { agentId: 'builder-import-spec' }, undefined]) {
      for (const tool of [list, read, propose]) {
        const result = await tool.execute({ item: 'spec:x', ops: [{}] }, context)
        assert.strictEqual(result.status, 'error', `${tool.name} ${JSON.stringify(context)}`)
      }
    }
    assert.deepStrictEqual(calls, [])
  })

  it('a conversa é a do contexto (nunca um argumento): lista, lê em páginas e entrega o rascunho', async () => {
    assert.deepStrictEqual(await list.execute({}, importer), { status: 'success', result: 'itens' })
    assert.deepStrictEqual(await read.execute({ item: 'spec:x', path: 'a.md', offset: 10.7, limit: 50 }, importer), { status: 'success', result: 'texto' })
    assert.deepStrictEqual(calls, ['list:c1', 'read:c1:spec:x:{"path":"a.md","offset":10,"limit":50}'])
    const ok = await propose.execute({ item: 'spec:x', ops: [{ op: 'remove' }] }, importer)
    assert.strictEqual(ok.status, 'success')
    assert.match(ok.result, /Draft saved on spec:x .*1 removal.*Nothing went to the catalog/)
  })

  it('os problemas voltam campo a campo, para o construtor corrigir', async () => {
    const result = await propose.execute({ item: 'spec:x', ops: [] }, importer)
    assert.deepStrictEqual(result, { status: 'error', result: 'the draft has problems — fix and call again:\n- ops[0].text: excerpt not found' })
  })

  it('⛔ nenhum agente do catálogo pode escolher as ferramentas de importação', () => {
    const catalog = new ToolCatalog(undefined as never, makeLocalTools({ imports: desk }), undefined)
    assert.ok(!catalog.localNames().some((name) => ['list_import_items', 'read_import_source', 'propose_import_draft'].includes(name)))
    assert.deepStrictEqual(
      catalog.localFor(['read_import_source']).map((tool) => tool.name),
      ['read_import_source'],
    )
  })
})
