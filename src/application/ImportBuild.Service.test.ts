import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { maskText } from '@domain/Secret.Mask'
import { IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { listRepoFiles, readRepoFile, readRepoText } from '@infra/import/Repo.Tree'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { FAKE_TOKEN } from '../testing/Import.Fixture'
import { IImportBuildDeps, IImportConversationInput, ImportBuildError, ImportBuildService, lastDraft } from './ImportBuild.Service'

const SPEC = '<!-- gerado por agents-sync -->\n# Arquitetura\nLeia `.agents/specs/filas.md` antes.\n'

describe('ImportBuildService', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-import-build-'))
  after(() => rmSync(base, { recursive: true, force: true }))
  let seq = 0

  function setup(extra: Partial<IImportBuildDeps> = {}) {
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
    file('.agents/agents/maya/AGENT.md', '# Maya\n')
    file('.agents/agents/maya/triggers/01-revisar.md', 'Quando pedirem revisão.\n')
    file('.agents/agents/maya/triggers/02-publicar.md', 'Quando pedirem publicação.\n')
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
      // O `docs/citado.md` fica fora do ambiente agêntico: é só referência (o construtor pode ler, por ser citado).
      item('spec:arquitetura', '.agents/specs/arquitetura.md', [{ path: '.agents/specs/filas.md', item: 'spec:filas' }, { path: 'docs/citado.md' }]),
      item('spec:filas', '.agents/specs/filas.md'),
      item('spec:config', '.agents/specs/config.md'),
      item('spec:outra', '.agents/specs/outra.md'),
      item('skill:revisar', '.agents/skills/revisar/SKILL.md'),
      item('mcp:github', '.agents/mcp.json'),
      { ...item('agent:maya', '.agents/agents/maya/AGENT.md'), candidateId: 'maya' },
      { ...item('trigger:maya/01-revisar', '.agents/agents/maya/triggers/01-revisar.md'), candidateId: '01-revisar', parent: 'agent:maya' },
      { ...item('trigger:maya/02-publicar', '.agents/agents/maya/triggers/02-publicar.md'), candidateId: '02-publicar', parent: 'agent:maya' },
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
          totals: { files: 6, items: 6, tokens: 6, byKind: { spec: 4, skill: 1 } },
          ignored: { dirs: {}, binaries: [], links: [], patterns: [] },
          scope: { places: [{ place: '.agents/', enabled: true, found: true, files: 9 }], extra: [], outside: 0 },
        },
        items: items.map((entry) => ({ key: entry.key, item: entry, state: 'pending', fingerprint: `f-${entry.key}`, drafts: [] })),
      })
    job('j1', '2026-10-30T10:00:00.000Z')
    const opened: IImportConversationInput[] = []
    const service = new ImportBuildService({
      repository,
      readSource: (_projectId, _repository, path) => readRepoFile(root, path, { mask: (text) => maskText(text, []) }),
      repositoryFiles: {
        list: (_projectId, _repository, under, exclude) => listRepoFiles(root, under, exclude),
        read: (_projectId, _repository, path, exclude) => readRepoText(root, path, { mask: (text) => maskText(text, []), exclude }),
      },
      openConversation: async (input) => {
        opened.push(input)
        return `c${opened.length}`
      },
      now: () => new Date('2026-10-30T12:00:00.000Z'),
      ...extra,
    })
    /** A próxima análise não acha estas chaves: elas saem da fonte (ficam, marcadas). */
    const leave = (...keys: string[]) =>
      repository.reanalyze({
        jobId: 'j1',
        scannedAt: new Date('2026-10-30T11:00:00.000Z'),
        by: 'ana',
        inventory: repository.get('alfa', 'j1')!.inventory,
        present: [],
        gone: keys,
        analysis: { at: new Date('2026-10-30T11:00:00.000Z'), by: 'ana', kept: 0, stale: [], added: [], gone: keys, restored: [], returned: [] },
      })
    return { root, file, repository, service, opened, job, leave }
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

  it('o agente aberto sozinho leva os triggers dele; o trigger já em outra conversa fica onde está', async () => {
    const { service } = setup()
    const first = await service.open('alfa', 'j1', 'ana', { keys: ['trigger:maya/02-publicar'] })
    assert.deepStrictEqual(first.keys, ['trigger:maya/02-publicar'])
    const agent = await service.open('alfa', 'j1', 'ana', { keys: ['agent:maya'] })
    assert.deepStrictEqual(agent.keys, ['agent:maya', 'trigger:maya/01-revisar'])
    // O construtor vê que o trigger de fora existe (e não pede para criá-lo).
    assert.match(service.listText(agent.conversationId), /1 trigger\(s\) of this agent are in the import job but NOT in this conversation \(trigger:maya\/02-publicar/)
  })

  it('preparar tudo: o lote salvo vai ao construtor de uma vez, uma conversa por construtor, só o que ainda vai', async () => {
    const { service, repository, opened } = setup()
    const keys = ['spec:filas', 'spec:arquitetura', 'skill:revisar', 'agent:maya', 'trigger:maya/01-revisar', 'trigger:maya/02-publicar', 'mcp:github', 'spec:outra']
    repository.createBatch({ id: 'b1', jobId: 'j1', name: 'maya', prefix: '', keys, order: keys, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    repository.updateItem('j1', 'spec:outra', { state: 'approved' })
    const conversations = await service.prepare('alfa', 'j1', 'b1', 'ana', { id: 'u1' })
    assert.deepStrictEqual(
      conversations.map((one) => [one.kind, one.keys]),
      [
        ['spec', ['spec:filas', 'spec:arquitetura']],
        ['skill', ['skill:revisar']],
        ['agent', ['agent:maya', 'trigger:maya/01-revisar', 'trigger:maya/02-publicar']],
      ],
    )
    assert.ok(opened.every((one) => one.owner?.id === 'u1' && (one.metadata.import as { batch?: string }).batch === 'b1'))
    assert.strictEqual(repository.item('j1', 'agent:maya')!.state, 'drafting')
    // De novo: nada mais vai.
    await rejects(() => service.prepare('alfa', 'j1', 'b1', 'ana'), 'invalid')
  })

  it('as conversas do lote: os itens de cada uma e o que o construtor ainda deve', async () => {
    const { service, repository } = setup()
    const keys = ['spec:filas', 'spec:arquitetura', 'skill:revisar', 'mcp:github']
    repository.createBatch({ id: 'b3', jobId: 'j1', name: 'specs', prefix: '', keys, order: keys, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    const [specs, skills] = await service.prepare('alfa', 'j1', 'b3', 'ana')
    repository.updateItem('j1', 'spec:filas', { state: 'review' })
    assert.deepStrictEqual(
      service.batchConversations('alfa', 'j1', 'b3').map((one) => [one.conversationId, one.kind, one.keys, one.pending]),
      [
        [specs.conversationId, 'spec', ['spec:filas', 'spec:arquitetura'], ['spec:arquitetura']],
        [skills.conversationId, 'skill', ['skill:revisar'], ['skill:revisar']],
      ],
    )
    assert.throws(() => service.batchConversations('alfa', 'j1', 'nao-existe'), /batch not found/)
  })

  it('preparar tudo: o agente já noutra conversa, sem rascunho, vem junto com os triggers dele', async () => {
    const { service, repository } = setup()
    const keys = ['agent:maya', 'trigger:maya/01-revisar', 'trigger:maya/02-publicar']
    repository.createBatch({ id: 'b2', jobId: 'j1', name: 'maya', prefix: '', keys, order: keys, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    // Aberto antes só com o agente (os triggers ficaram pendentes).
    repository.updateItem('j1', 'agent:maya', { state: 'drafting', conversationId: 'velha' })
    const [agent] = await service.prepare('alfa', 'j1', 'b2', 'ana')
    assert.deepStrictEqual(agent.keys, ['agent:maya', 'trigger:maya/01-revisar', 'trigger:maya/02-publicar'])
    assert.strictEqual(repository.item('j1', 'agent:maya')!.conversationId, agent.conversationId)
  })

  it('⛔ abrir recusa: construtores misturados, tipo sem construtor, item fora do trabalho, item que saiu da fonte', async () => {
    const { service, leave } = setup()
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'skill:revisar'] }), 'kind')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['mcp:github'] }), 'kind')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:nada'] }), 'not_found')
    await rejects(() => service.open('beta', 'j1', 'ana', { keys: ['spec:filas'] }), 'not_found')
    leave('spec:filas')
    await rejects(() => service.open('alfa', 'j1', 'ana', { keys: ['spec:filas'] }), 'transition')
  })

  it('⛔ o que saiu da fonte não vai ao Preparar nem fica na conversa; os outros do lote seguem', async () => {
    const { service, repository, leave } = setup()
    const keys = ['spec:filas', 'spec:outra', 'spec:arquitetura']
    repository.createBatch({ id: 'b7', jobId: 'j1', name: 'specs', prefix: '', keys, order: keys, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    leave('spec:filas', 'spec:arquitetura')
    const [opened] = await service.prepare('alfa', 'j1', 'b7', 'ana')
    assert.deepStrictEqual(opened.keys, ['spec:outra'])
    assert.strictEqual(repository.item('j1', 'spec:filas')!.state, 'pending', 'fica como estava')
    assert.deepStrictEqual(
      service.batchConversations('alfa', 'j1', 'b7').map((one) => one.keys),
      [['spec:outra']],
    )
    // A conversa de um item que saiu da fonte não tem mais o que fazer.
    code(() => service.listText('c1'), 'not_found')
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

  it('list_import_items abre com o resumo do repositório: o ambiente achado, formatos, itens por tipo; e diz quem cita o item', async () => {
    const { service, file } = setup()
    file('docs/leia.md', '# Leia\n')
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:filas'] })
    const text = service.listText('c1')
    assert.match(text.split('\n')[1], /^Repository: agentic environment \.agents\/ · formats \.agents\/ · 6 file\(s\) scanned, 6 item\(s\) \(spec 4, skill 1\)\.$/)
    assert.match(text, /- cited by \(in the repository\): spec:arquitetura/)
  })

  it('list_repository_files: SÓ o ambiente agêntico — a raiz, uma pasta, um padrão; ⛔ sem os excluídos nem o ignorar (do projeto e da análise); no máximo 300', async () => {
    const { service, file, repository } = setup({ projectIgnore: () => ['rascunhos'] })
    file('.env', `GITHUB_TOKEN=${FAKE_TOKEN}\n`)
    file('.credentials/conta.json', '{}')
    file('.git/config', '[core]\n')
    file('rascunhos/x.md', 'x')
    file('saidas/y.md', 'y')
    file('docs/leia.md', '# Leia\n')
    repository.reanalyze({
      jobId: 'j1',
      scannedAt: new Date('2026-10-30T11:00:00.000Z'),
      by: 'ana',
      inventory: { ...repository.get('alfa', 'j1')!.inventory, ignored: { dirs: {}, binaries: [], links: [], patterns: [{ pattern: 'saidas', origin: 'request', files: 1 }] } },
      present: [],
      gone: [],
      analysis: { at: new Date('2026-10-30T11:00:00.000Z'), by: 'ana', kept: 0, stale: [], added: [], gone: [], restored: [], returned: [] },
    })
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const all = service.listRepository('c1')
    assert.match(all, /^Repository app — 9 file\(s\) of the agentic environment from the root/)
    assert.match(all, /- \.agents\/specs\/arquitetura\.md · \d+ bytes · import item spec:arquitetura/)
    // ⛔ O código do projeto (fora do ambiente) não aparece, nem pedindo a pasta.
    for (const hidden of ['.env', '.credentials', '.git/', 'rascunhos', 'saidas', 'docs/leia.md']) assert.ok(!all.includes(hidden), hidden)
    assert.match(service.listRepository('c1', { path: 'docs' }), /0 file\(s\) of the agentic environment under docs/)
    const specs = service.listRepository('c1', { pattern: '.agents/specs/*.md' })
    assert.match(specs, /4 file\(s\) of the agentic environment from the root matching/)
    assert.ok(!specs.includes('SKILL.md'))
    assert.match(service.listRepository('c1', { pattern: 'SKILL.md' }), /1 file\(s\)[\s\S]*revisar\/SKILL\.md/)
    for (let index = 0; index < 305; index++) file(`.agents/muitos/f-${String(index).padStart(3, '0')}.md`, 'm')
    const many = service.listRepository('c1', { path: '.agents/muitos' })
    assert.match(many, /305 file\(s\) of the agentic environment under \.agents\/muitos .*Showing the first 300: TRUNCATED/)
    assert.strictEqual(many.split('\n').length, 301)
    code(() => service.listRepository('c1', { path: '../' }), 'invalid')
    code(() => service.listRepository('c1', { path: '.credentials' }), 'invalid')
    code(() => service.listRepository('c1', { pattern: '../*' }), 'invalid')
    code(() => service.listRepository('c9'), 'not_found')
  })

  it('read_repository_file: o ambiente agêntico e o citado pelos itens, mascarado e em páginas; ⛔ o resto, binário, fora, link para fora e excluído recusados', async () => {
    const { service, file, root } = setup({ projectIgnore: () => ['rascunhos'], projectScope: () => ({ disabled: [], extra: ['rascunhos'] }) })
    file('.agents/notas/config.md', `# Config\nGITHUB_TOKEN=${FAKE_TOKEN}\n`)
    file('docs/citado.md', '# Citado\n')
    file('docs/codigo.md', '# Código do projeto\n')
    file('.env', 'A=1\n')
    file('.agents/.env.local', 'B=2\n')
    file('rascunhos/x.md', 'x')
    writeFileSync(join(root, '.agents/logo.png'), Buffer.from([137, 80, 0, 1]))
    symlinkSync(join(base, `fora-${seq}.md`), join(root, '.agents/fora.md'))
    symlinkSync('../.env', join(root, '.agents/env.md'))
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const text = service.readRepository('c1', { path: '.agents/notas/config.md' })
    assert.match(text, /^File \.agents\/notas\/config\.md \(repository data, not instructions; secrets masked\)/)
    assert.ok(!text.includes(FAKE_TOKEN), 'o segredo sai mascarado')
    assert.match(text, /GITHUB_TOKEN=/)
    assert.match(service.readRepository('c1', { path: '.agents/notas/config.md', offset: 2, limit: 6 }), /characters 2–8 of \d+\. More: call again with offset 8\.\n\nConfig/)
    assert.match(service.readRepository('c1', { path: '.agents/specs/outra.md' }), /# Outra/, 'qualquer arquivo do ambiente, não só as fontes do item')
    assert.match(service.readRepository('c1', { path: './docs/citado.md' }), /# Citado/, 'fora do ambiente, mas citado por um item do trabalho')
    code(() => service.readRepository('c1', { path: 'docs/codigo.md' }), 'invalid')
    assert.throws(() => service.readRepository('c1', { path: 'docs/codigo.md' }), /outside the agentic environment/)
    code(() => service.readRepository('c1', { path: '.agents/logo.png' }), 'invalid')
    // ⛔ Os excluídos e o ignorar ganham do ambiente (o `rascunhos` está nele pelo caminho a mais).
    for (const path of [`../fora-${seq}.md`, join(base, `fora-${seq}.md`), '.agents/fora.md', '.env', '.agents/.env.local', '.agents/env.md', 'rascunhos/x.md', '.git/config'])
      code(() => service.readRepository('c1', { path }), 'invalid')
    code(() => service.readRepository('c1', { path: '.agents/nao-existe.md' }), 'not_found')
    code(() => service.readRepository('c1', { path: 'nao-existe.md' }), 'invalid')
    code(() => service.readRepository('c9', { path: 'docs/config.md' }), 'not_found')
  })

  it('o ambiente da navegação é o do projeto (o de agora) e o da análise: os caminhos a mais entram; desligar estreita a conversa aberta', async () => {
    let scope = { disabled: [] as string[], extra: ['docs'] }
    const { service, file } = setup({ projectScope: () => scope })
    file('docs/leia.md', '# Leia\n')
    file('.agents/notas/n.md', '# Nota\n')
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    // A análise rodou sem o `docs`: o caminho a mais de agora só vale na próxima análise.
    assert.ok(!service.listRepository('c1').includes('docs/leia.md'))
    code(() => service.readRepository('c1', { path: 'docs/leia.md' }), 'invalid')
    scope = { disabled: ['.agents/'], extra: [] }
    assert.match(service.listRepository('c1'), /0 file\(s\) of the agentic environment/)
    code(() => service.readRepository('c1', { path: '.agents/notas/n.md' }), 'invalid')
    // A fonte de um item do trabalho continua legível (é o que a importação traz).
    assert.match(service.readRepository('c1', { path: '.agents/specs/outra.md' }), /# Outra/)
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

  it('⛔ o rascunho que só a gravação recusaria é recusado ao propor: limite do catálogo e escopo', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const issues = (meta: Record<string, string>) => {
      try {
        service.propose('c1', 'spec:arquitetura', meta, OPS)
        return []
      } catch (error) {
        return (error as ImportBuildError).issues.map((issue) => `${issue.field}: ${issue.message}`)
      }
    }
    assert.deepStrictEqual(issues({ ...META, summary: 'x'.repeat(301) }), ['meta.summary: at most 300 characters in the catalog (this one has 301): shorten it'])
    assert.deepStrictEqual(issues({ ...META, title: 'x'.repeat(161) }), ['meta.title: at most 160 characters in the catalog (this one has 161): shorten it'])
    assert.deepStrictEqual(issues({ ...META, scope: 'global' }), ['meta.scope: an import always goes to the project: drop scope'])
    assert.strictEqual(repository.item('j1', 'spec:arquitetura')!.state, 'drafting')
  })

  it('⛔ vínculo para id que não é do trabalho nem documento do catálogo é recusado; o do catálogo passa', async () => {
    const { service } = setup({ docExists: (id) => id === 'ja-no-catalogo' })
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    assert.throws(
      () => service.propose('c1', 'spec:arquitetura', META, [OPS[0], { ...OPS[1], target: 'memory-decisions-md' }]),
      (error: unknown) => error instanceof ImportBuildError && /memory-decisions-md is no document of this import job nor of the catalog/.test(error.issues[0].message),
    )
    assert.strictEqual(service.propose('c1', 'spec:arquitetura', META, [OPS[0], { ...OPS[1], target: 'ja-no-catalogo' }]).item.state, 'review')
  })

  it('⛔ vínculo para um item do trabalho que não é documento (uma skill) é recusado: o painel só anexa spec, ADR ou knowledge', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura'] })
    const toSkill = [OPS[0], { ...OPS[1], target: 'revisar', link: 'reference' }]
    assert.throws(
      () => service.propose('c1', 'spec:arquitetura', META, toSkill),
      (error: unknown) => error instanceof ImportBuildError && error.issues?.[0]?.field === 'ops[1].target' && /revisar is a skill \(skill:revisar\)/.test(error.issues[0].message),
    )
    assert.strictEqual(repository.item('j1', 'spec:arquitetura')!.state, 'drafting')
    // Id fora do trabalho não se julga aqui (pode já estar no catálogo).
    assert.strictEqual(service.propose('c1', 'spec:arquitetura', META, [OPS[0], { ...OPS[1], target: 'ja-no-catalogo' }]).item.state, 'review')
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

  it('list_import_items mostra as remoções que a pessoa já aprovou no trabalho, pelo motivo: não se pergunta de novo', async () => {
    const { service } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'spec:filas'] })
    assert.doesNotMatch(service.listText('c1'), /already approved/)
    service.propose('c1', 'spec:arquitetura', META, OPS)
    assert.doesNotMatch(service.listText('c1'), /already approved/, 'só o aprovado conta')
    service.approve('alfa', 'j1', 'spec:arquitetura', [0], 'ana')
    assert.match(service.listText('c1'), /## Removals the person already approved[\s\S]*- cabeçalho de gerado — approved 1× \(e\.g\. "<!-- gerado por agents-sync -->"\)/)
  })

  it('reclassificar pela conversa: só item dela sem rascunho; sai da conversa e volta à fila com o tipo novo', async () => {
    const { service, repository } = setup()
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:arquitetura', 'spec:filas'] })
    code(() => service.reclassify('c1', 'spec:outra', 'knowledge', 'r'), 'not_found')
    code(() => service.reclassify('c1', 'spec:filas', 'mcp', 'r'), 'kind')
    code(() => service.reclassify('c1', 'spec:filas', 'spec', 'r'), 'invalid')
    code(() => service.reclassify('c1', 'spec:filas', 'knowledge', ' '), 'invalid')
    const moved = service.reclassify('c1', 'spec:filas', 'knowledge', 'a pessoa pediu')
    assert.deepStrictEqual([moved.state, moved.kind, moved.conversationId, moved.by], ['pending', 'knowledge', undefined, 'builder:c1'])
    assert.doesNotMatch(service.listText('c1'), /## spec:filas/)
    // De volta ao tipo detectado: a reclassificação some.
    await service.open('alfa', 'j1', 'ana', { keys: ['spec:filas'] })
    assert.strictEqual(service.reclassify('c2', 'spec:filas', 'spec', 'voltou').kind, undefined)
    // Com rascunho, não.
    service.propose('c1', 'spec:arquitetura', META, OPS)
    repository.updateItem('j1', 'spec:arquitetura', { state: 'drafting' })
    code(() => service.reclassify('c1', 'spec:arquitetura', 'knowledge', 'r'), 'transition')
  })

  it('a conversa apagada solta os itens do lote no construtor: o Preparar abre outra para eles', async () => {
    const { service, repository } = setup()
    const keys = ['spec:filas', 'spec:arquitetura', 'skill:revisar']
    repository.createBatch({ id: 'b9', jobId: 'j1', name: 'x', prefix: '', keys, order: keys, by: 'ana', at: new Date('2026-10-30T11:30:00.000Z') })
    const [specs] = await service.prepare('alfa', 'j1', 'b9', 'ana')
    const released = await service.releaseLost('alfa', 'j1', 'b9', async (id) => id !== specs.conversationId)
    assert.deepStrictEqual(released, ['spec:filas', 'spec:arquitetura'])
    assert.deepStrictEqual([repository.item('j1', 'spec:filas')!.state, repository.item('j1', 'spec:filas')!.conversationId], ['drafting', undefined])
    const [again] = await service.prepare('alfa', 'j1', 'b9', 'ana')
    assert.deepStrictEqual([again.kind, again.keys], ['spec', ['spec:filas', 'spec:arquitetura']])
  })
})
