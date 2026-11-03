import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IImportDraft } from '@domain/Import.Draft'
import { IImportDesk, makeImportTools } from './Import.Tools'
import { loopLimits } from '@domain/Loop.Policy'
import { LoopGuard } from './Loop.Guard'
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
    reclassify: (conversation, key, kind, reason) => {
      if (kind === 'mcp') throw new Error('no builder imports a mcp')
      return calls.push(`reclassify:${conversation}:${key}:${String(kind)}:${String(reason)}`)
    },
    listRepository: (conversation, options) => (calls.push(`files:${conversation}:${JSON.stringify(options)}`), 'arquivos'),
    readRepository: (conversation, options) => {
      if (options.path === '.env') throw new Error('.env: excluded')
      return (calls.push(`file:${conversation}:${JSON.stringify(options)}`), 'conteúdo')
    },
  }
  const [list, read, propose, reclassify, files, file] = makeImportTools(desk)
  const importer = { agentId: 'builder-import-spec', sessionId: 'c1' }

  it('⛔ só o construtor em modo importação, e só numa conversa', async () => {
    for (const context of [{ agentId: 'builder-spec', sessionId: 'c1' }, { agentId: 'atlas', sessionId: 'c1' }, { agentId: 'builder-import-spec' }, undefined]) {
      for (const tool of [list, read, propose, reclassify, files, file]) {
        const result = await tool.execute({ item: 'spec:x', ops: [{}], path: 'a.md' }, context)
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

  it('reclassificar: a conversa do contexto, o tipo e o motivo; diz à pessoa como seguir', async () => {
    calls.length = 0
    const ok = await reclassify.execute({ item: 'knowledge:x', kind: 'spec', reason: 'a pessoa disse: spec' }, importer)
    assert.strictEqual(ok.status, 'success')
    assert.match(ok.result, /knowledge:x is now a spec .*Retomar as paradas/)
    assert.deepStrictEqual(calls, ['reclassify:c1:knowledge:x:spec:a pessoa disse: spec'])
    assert.deepStrictEqual(await reclassify.execute({ item: 'knowledge:x', kind: 'mcp', reason: 'r' }, importer), { status: 'error', result: 'no builder imports a mcp' })
  })

  it('o repositório da conversa: lista (path, pattern) e lê em páginas; a recusa volta como erro', async () => {
    calls.length = 0
    assert.deepStrictEqual(await files.execute({ path: 'docs', pattern: '*.md' }, importer), { status: 'success', result: 'arquivos' })
    assert.deepStrictEqual(await files.execute({}, importer), { status: 'success', result: 'arquivos' })
    assert.deepStrictEqual(await file.execute({ path: 'docs/a.md', offset: 3.2, limit: 10 }, importer), { status: 'success', result: 'conteúdo' })
    assert.deepStrictEqual(calls, ['files:c1:{"path":"docs","pattern":"*.md"}', 'files:c1:{}', 'file:c1:{"path":"docs/a.md","offset":3,"limit":10}'])
    assert.deepStrictEqual(await file.execute({ path: '.env' }, importer), { status: 'error', result: '.env: excluded' })
    assert.strictEqual((await file.execute({}, importer)).status, 'error')
  })

  it('⛔ as ferramentas do repositório passam pela mesma guarda de repetição das locais', async () => {
    const loops = new LoopGuard(() => ({ ...loopLimits(), refuseAt: 2 }))
    loops.open('c1')
    const tools = makeLocalTools({ imports: desk, loops })
    const guarded = tools.find((tool) => tool.name === 'read_repository_file')!
    assert.strictEqual((await guarded.execute({ path: 'docs/b.md' }, importer)).status, 'success')
    const before = calls.length
    const repeated = await guarded.execute({ path: 'docs/b.md' }, importer)
    assert.strictEqual(repeated.status, 'error')
    assert.strictEqual(calls.length, before, 'recusada antes de rodar')
  })

  it('os problemas voltam campo a campo, para o construtor corrigir', async () => {
    const result = await propose.execute({ item: 'spec:x', ops: [] }, importer)
    assert.deepStrictEqual(result, { status: 'error', result: 'the draft has problems — fix and call again:\n- ops[0].text: excerpt not found' })
  })

  it('⛔ nenhum agente do catálogo pode escolher as ferramentas de importação', () => {
    const catalog = new ToolCatalog(undefined as never, makeLocalTools({ imports: desk }), undefined)
    assert.ok(
      !catalog.localNames().some((name) => ['list_import_items', 'read_import_source', 'propose_import_draft', 'list_repository_files', 'read_repository_file'].includes(name)),
    )
    assert.deepStrictEqual(
      catalog.localFor(['read_import_source']).map((tool) => tool.name),
      ['read_import_source'],
    )
  })
})
