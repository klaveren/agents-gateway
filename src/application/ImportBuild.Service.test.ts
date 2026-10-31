import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { maskText } from '@domain/Secret.Mask'
import { IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { readRepoFile } from '@infra/import/Repo.Tree'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { FAKE_TOKEN } from '../testing/Import.Fixture'
import { IImportConversationInput, ImportBuildError, ImportBuildService, lastDraft } from './ImportBuild.Service'

const SPEC = '<!-- gerado por agents-sync -->\n# Arquitetura\nLeia `.agents/specs/filas.md` antes.\n'

describe('ImportBuildService', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-import-build-'))
  after(() => rmSync(base, { recursive: true, force: true }))
  let seq = 0

  function setup() {
    const root = join(base, `repo-${++seq}`)
    const file = (path: string, body: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), body)
    }
    file('.agents/specs/arquitetura.md', SPEC)
    file('.agents/specs/filas.md', '# Filas\n')
    file('.agents/specs/config.md', `# Config\nGITHUB_TOKEN=${FAKE_TOKEN}\n`)
    file('.agents/specs/outra.md', '# Outra\n')
    file('.agents/skills/revisar/SKILL.md', '# Revisar\n')
    file('.agents/mcp.json', '{}\n')
    writeFileSync(join(base, `fora-${seq}.md`), 'de fora\n')
    const sha = (path: string) =>
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex')
    const item = (key: string, path: string, refs: IInventoryItem['refs'] = []): IInventoryItem => {
      const [kind, id] = key.split(':') as [TInventoryKind, string]
      return { key, kind, candidateId: id, detectors: ['agents-dir'], sources: [{ path, aliases: [], bytes: 1, tokens: 1, sha256: sha(path) }], refs, unresolved: [], notes: [] }
    }
    const items = [
      item('spec:arquitetura', '.agents/specs/arquitetura.md', [{ path: '.agents/specs/filas.md', item: 'spec:filas' }]),
      item('spec:filas', '.agents/specs/filas.md'),
      item('spec:config', '.agents/specs/config.md'),
      item('spec:outra', '.agents/specs/outra.md'),
      item('skill:revisar', '.agents/skills/revisar/SKILL.md'),
      item('mcp:github', '.agents/mcp.json'),
    ]
    const repository = new SqliteImportRepository()
    const job = (id: string, at: string) =>
      repository.create({
        id,
        projectId: 'alfa',
        repository: 'app',
        scannedAt: new Date(at),
        by: 'ana',
        inventory: {
          projectId: 'alfa',
          repository: 'app',
          scannedAt: new Date(at),
          formats: ['agents-dir'],
          totals: { files: 6, items: 6, tokens: 6, byKind: {} },
          ignored: { dirs: {}, binaries: [], links: [], patterns: [] },
        },
        items: items.map((entry) => ({ key: entry.key, item: entry, state: 'pending', fingerprint: `f-${entry.key}`, drafts: [] })),
      })
    job('j1', '2026-10-30T10:00:00.000Z')
    const opened: IImportConversationInput[] = []
    const service = new ImportBuildService({
      repository,
      readSource: (_projectId, _repository, path) => readRepoFile(root, path, { mask: (text) => maskText(text, []) }),
      openConversation: async (input) => {
        opened.push(input)
        return `c${opened.length}`
      },
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })
    return { root, file, repository, service, opened, job }
  }

  const code = (work: () => unknown, expected: ImportBuildError['code']) => assert.throws(work, (error: unknown) => error instanceof ImportBuildError && error.code === expected)
  const rejects = (work: () => Promise<unknown>, expected: ImportBuildError['code']) =>
    assert.rejects(work, (error: unknown) => error instanceof ImportBuildError && error.code === expected)

  it('abrir: UMA conversa com o construtor do tipo (modo importação) para o lote; os itens vão a drafting, ligados a ela', async () => {
    const { service, repository, opened } = setup()
    const result = await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'spec:filas'], owner: { id: 'u1' } })
    assert.deepStrictEqual(result, { conversationId: 'c1', kind: 'spec', agentId: 'builder-import-spec', keys: ['spec:arquitetura', 'spec:filas'] })
    assert.deepStrictEqual(opened[0], {
      kind: 'spec',
      agentId: 'builder-import-spec',
      projectId: 'alfa',
      metadata: { import: { job: 'j1', keys: ['spec:arquitetura', 'spec:filas'] } },
      owner: { id: 'u1' },
    })
    const entry = repository.item('j1', 'spec:arquitetura')!
    assert.deepStrictEqual([entry.state, entry.conversationId, entry.by], ['drafting', 'c1', 'ana'])
    assert.strictEqual(repository.item('j1', 'spec:outra')!.state, 'pending')
  })

  it('abrir para um LOTE SALVO: os itens dele que ainda vão ao construtor, do construtor pedido quando o lote mistura tipos', async () => {
    const { service, repository, opened } = setup()
    const order = ['spec:filas', 'spec:arquitetura', 'skill:revisar', 'spec:outra']
    repository.createBatch({ id: 'b1', jobId: 'j1', name: 'specs e skill', prefix: '', keys: order, order, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    repository.updateItem('j1', 'spec:outra', { state: 'skipped' })
    // Misturado sem dizer o construtor: recusa; com `kind`, só os dele, na ordem do lote, sem o excluído.
    await rejects(() => service.open('alfa', 'j1', 'ana', { batchId: 'b1' }), 'kind')
    const specs = await service.open('alfa', 'j1', 'ana', { batchId: 'b1', kind: 'spec' })
    assert.deepStrictEqual(specs.keys, ['spec:filas', 'spec:arquitetura'])
    assert.deepStrictEqual(opened[0].metadata, { import: { job: 'j1', keys: ['spec:filas', 'spec:arquitetura'], batch: 'b1' } })
    // Os que já têm conversa não voltam a outra; o que sobra é a skill.
    assert.deepStrictEqual((await service.open('alfa', 'j1', 'ana', { batchId: 'b1' })).keys, ['skill:revisar'])
    await rejects(() => service.open('alfa', 'j1', 'ana', { batchId: 'b1' }), 'invalid')
    await rejects(() => service.open('alfa', 'j1', 'ana', { batchId: 'nao-existe' }), 'not_found')
    await rejects(() => service.open('alfa', 'j1', 'ana', { batchId: 'b1', keys: ['spec:config'] }), 'invalid')
  })

  it('⛔ abrir recusa: construtores misturados, tipo sem construtor, item fora do trabalho, trabalho antigo', async () => {
    const { service, job } = setup()
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'skill:revisar'] }), 'kind')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['mcp:github'] }), 'kind')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:nada'] }), 'not_found')
    await rejects(() => service.open('beta', 'j1', 'ana', { keys: ['spec:filas'] }), 'not_found')
    job('j2', '2026-10-30T11:00:00.000Z')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:filas'] }), 'outdated')
  })

  it('list_import_items: os itens da conversa, as fontes e o mapa de ids do que citam', async () => {
    const { service } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const text = service.listText('c1')
    assert.match(text, /## spec:arquitetura/)
    assert.match(text, /\.agents\/specs\/filas\.md → spec:filas → filas/)
    assert.ok(!text.includes('spec:outra'), 'só os itens desta conversa')
    code(() => service.listText('c9'), 'not_found')
  })

  it('read_import_source: lê pelo servidor, MASCARADO e em páginas; só a fonte do item e o que ele cita', async () => {
    const { service } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'spec:config'] })
    assert.match(service.readSource('c1', 'spec:arquitetura'), /sha256 checked[\s\S]*# Arquitetura/)
    const config = service.readSource('c1', 'spec:config')
    assert.ok(!config.includes(FAKE_TOKEN), 'o segredo sai mascarado')
    assert.match(config, /GITHUB_TOKEN=/)
    // O que o item cita (outro item do trabalho) também se lê.
    assert.match(service.readSource('c1', 'spec:arquitetura', { path: '.agents/specs/filas.md' }), /# Filas/)
    const page = service.readSource('c1', 'spec:arquitetura', { offset: 0, limit: 10 })
    assert.match(page, /characters 0–10 of \d+\. More: call again with offset 10/)
    // ⛔ Fora do item: outro arquivo do repositório, caminho para fora, item de outra conversa.
    code(() => service.readSource('c1', 'spec:arquitetura', { path: '.agents/specs/outra.md' }), 'not_found')
    code(() => service.readSource('c1', 'spec:arquitetura', { path: `../fora-${seq}.md` }), 'not_found')
    code(() => service.readSource('c1', 'spec:outra'), 'not_found')
    code(() => service.readSource('c2', 'spec:arquitetura'), 'not_found')
  })

  it('⛔ read_import_source recusa a fonte com sha256 diferente do trabalho ("analise de novo")', async () => {
    const { service, file } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    file('.agents/specs/arquitetura.md', `${SPEC}mudou\n`)
    code(() => service.readSource('c1', 'spec:arquitetura'), 'source_changed')
  })

  const OPS = [
    { op: 'remove', text: '<!-- gerado por agents-sync -->\n', reason: 'cabeçalho de gerado' },
    { op: 'linkCitation', text: '.agents/specs/filas.md', target: 'filas', link: 'attach' },
  ]
  const META = { id: 'arquitetura', title: 'Arquitetura', summary: 'As camadas.' }

  it('propose_import_draft: aplica, confere, grava o rascunho no item e o manda a review', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const { draft } = service.propose('c1', 'spec:arquitetura', META, OPS)
    assert.strictEqual(draft.outputs[0].fields.body, '# Arquitetura\nLeia `filas` antes.')
    assert.deepStrictEqual(draft.meta, META)
    assert.deepStrictEqual(
      draft.ops.slice(2).map((op) => op.op),
      ['setMeta', 'setMeta', 'setMeta'],
    )
    const entry = repository.item('j1', 'spec:arquitetura')!
    assert.strictEqual(entry.state, 'review')
    assert.deepStrictEqual(lastDraft(entry), JSON.parse(JSON.stringify(draft)))
  })

  it('⛔ propose_import_draft com operação que não serve volta os problemas e não grava', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    assert.throws(
      () => service.propose('c1', 'spec:arquitetura', META, [{ op: 'remove', text: 'não existe', reason: 'x' }]),
      (error: unknown) => error instanceof ImportBuildError && error.code === 'invalid' && /excerpt not found/.test(JSON.stringify(error.issues)),
    )
    assert.throws(() => service.propose('c1', 'spec:arquitetura', { body: 'texto livre' }, []), /draft has problems/)
    assert.strictEqual(repository.item('j1', 'spec:arquitetura')!.state, 'drafting')
    code(() => service.propose('c1', 'spec:filas', META, []), 'not_found')
  })

  it('⛔ aprovar sem OK em toda remoção é recusado; com OK, o item vai a approved (nada no catálogo)', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    code(() => service.approve('alfa', 'j1', 'spec:arquitetura', [], 'ana'), 'transition')
    service.propose('c1', 'spec:arquitetura', META, OPS)
    code(() => service.approve('alfa', 'j1', 'spec:arquitetura', [], 'ana'), 'removals')
    code(() => service.approve('alfa', 'j1', 'spec:arquitetura', [1], 'ana'), 'removals')
    const approved = service.approve('alfa', 'j1', 'spec:arquitetura', [0], 'bia')
    assert.deepStrictEqual([approved.state, approved.approvedBy, approved.review], ['approved', 'bia', { removals: [0], by: 'bia', at: '2026-10-30T12:00:00.000Z' }])
    assert.strictEqual(repository.item('j1', 'spec:arquitetura')!.state, 'approved')
  })

  it('⛔ aprovar confere de novo com a fonte: fonte mudada depois do rascunho é recusada', async () => {
    const { service, file } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    service.propose('c1', 'spec:arquitetura', META, OPS)
    file('.agents/specs/arquitetura.md', SPEC.replace('antes', 'depois'))
    code(() => service.approve('alfa', 'j1', 'spec:arquitetura', [0], 'ana'), 'source_changed')
  })

  it('pedir ajuste: volta a drafting com o comentário, que a conversa lê nos itens; o rascunho novo volta a review', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    service.propose('c1', 'spec:arquitetura', META, OPS)
    const adjusted = service.adjust('alfa', 'j1', 'spec:arquitetura', 'mantenha o cabeçalho', 'bia')
    assert.strictEqual(adjusted.state, 'drafting')
    assert.match(service.listText('c1'), /asked for an adjustment: mantenha o cabeçalho/)
    service.propose('c1', 'spec:arquitetura', META, OPS.slice(1))
    const entry = repository.item('j1', 'spec:arquitetura')!
    assert.strictEqual(entry.state, 'review')
    assert.strictEqual(lastDraft(entry)!.removals.length, 0)
    // Sem remoção, aprova sem OK nenhum.
    assert.strictEqual(service.approve('alfa', 'j1', 'spec:arquitetura', [], 'bia').state, 'approved')
    code(() => service.adjust('alfa', 'j1', 'spec:arquitetura', 'x', 'bia'), 'transition')
  })
})
