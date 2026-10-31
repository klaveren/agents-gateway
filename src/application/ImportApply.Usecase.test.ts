import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { CatalogWideningConfirmationError, CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { buildCatalogStack } from '../testing/Catalog.Fixture'
import type { ICatalogWriter } from './Catalog.Writer'
import { IImportApplySelection, ImportApplyUseCase } from './ImportApply.Usecase'
import { ImportBuildError, ImportBuildService } from './ImportBuild.Service'

const ADMIN = { by: 'root@x.test', viaAccessToken: false }
const CI = { by: 'ci@x.test', viaAccessToken: true }
const MODEL = { 'agent:maya': { provider: 'google', model: 'gemini-3.7-flash' } }

const SOURCES: Record<string, string> = {
  '.agents/specs/arq.md': '# Arquitetura\nCorpo da arquitetura.\n',
  '.agents/specs/outro.md': '# Outro\n',
  '.agents/skills/revisar/SKILL.md': '# Revisar\nLeia `.agents/specs/arq.md` antes.\n',
  '.agents/agents/maya/prompt.md': 'Você é a Maya.\nContexto em `.agents/specs/arq.md`.\n',
  '.agents/agents/maya/triggers/01-revisar.md': 'Quando pedirem revisão, use a skill revisar.\n',
  '.agents/rules/commits.md': 'Use mensagens claras.\n',
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Um repositório sintético (em memória), o trabalho com os itens, o construtor, o catálogo e a gravação. */
async function setup(options: { wrapWriter?: (writer: ICatalogWriter) => ICatalogWriter } = {}) {
  const files = { ...SOURCES }
  const item = (key: string, path: string, refs: IInventoryItem['refs'] = [], parent?: string): IInventoryItem => {
    const [kind, id] = key.split(':') as [TInventoryKind, string]
    return {
      key,
      kind,
      candidateId: id.includes('/') ? id.slice(id.indexOf('/') + 1) : id,
      ...(parent ? { parent } : {}),
      ...(kind === 'rule' ? { title: 'Commits' } : {}),
      detectors: ['agents-dir'],
      sources: [{ path, aliases: [], bytes: 1, tokens: 1, sha256: sha(files[path]) }],
      refs,
      unresolved: [],
      notes: [],
    }
  }
  const arq = { path: '.agents/specs/arq.md', item: 'spec:arq' }
  const items = [
    item('spec:arq', '.agents/specs/arq.md'),
    item('spec:outro', '.agents/specs/outro.md'),
    item('skill:revisar', '.agents/skills/revisar/SKILL.md', [arq]),
    item('agent:maya', '.agents/agents/maya/prompt.md', [arq, { path: '.agents/skills/revisar/SKILL.md', item: 'skill:revisar' }]),
    item('trigger:maya/revisar', '.agents/agents/maya/triggers/01-revisar.md', [], 'agent:maya'),
    item('rule:commits', '.agents/rules/commits.md'),
  ]
  const repository = new SqliteImportRepository()
  repository.create({
    id: 'j1',
    projectId: 'alfa',
    repository: 'app',
    head: 'abc123',
    scannedAt: new Date('2026-10-30T10:00:00.000Z'),
    by: 'ana',
    inventory: {
      projectId: 'alfa',
      repository: 'app',
      scannedAt: new Date('2026-10-30T10:00:00.000Z'),
      formats: ['agents-dir', 'opencode'],
      totals: { files: 6, items: 6, tokens: 6, byKind: {} },
      ignored: { dirs: {}, binaries: [], links: [], patterns: [] },
    },
    items: items.map((entry) => ({ key: entry.key, item: entry, state: 'pending', fingerprint: `f-${entry.key}`, drafts: [] })),
  })
  const readSource = (_projectId: string, _repository: string, path: string) => (path in files ? { sha256: sha(files[path]), text: files[path], binary: false } : undefined)
  let conversations = 0
  const build = new ImportBuildService({ repository, readSource, openConversation: async () => `c${++conversations}` })

  // O construtor (à mão, como o modelo faria): fonte + operações, e a pessoa aprova.
  const propose = async (keys: string[], drafts: Record<string, { meta: Record<string, string>; ops?: unknown[] }>) => {
    const { conversationId } = await build.open('alfa', 'j1', 'ana', { keys })
    for (const key of keys) {
      build.propose(conversationId, key, drafts[key].meta, drafts[key].ops ?? [])
      build.approve('alfa', 'j1', key, [], 'ana')
    }
  }
  const cite = (target: string, link: string) => ({ op: 'linkCitation', text: '.agents/specs/arq.md', target, link })
  await propose(['spec:arq'], { 'spec:arq': { meta: { id: 'arq', title: 'Arquitetura', summary: 'Como é' } } })
  await propose(['skill:revisar'], { 'skill:revisar': { meta: { id: 'revisar', description: 'Revisa código' }, ops: [cite('arq', 'attach')] } })
  await propose(['rule:commits'], { 'rule:commits': { meta: { title: 'Commits' } } })
  await propose(['agent:maya', 'trigger:maya/revisar'], {
    'agent:maya': { meta: { id: 'maya', name: 'Maya' }, ops: [cite('arq', 'initialContext')] },
    'trigger:maya/revisar': { meta: { id: 'revisar', when: 'pedirem revisão' } },
  })

  const stack = buildCatalogStack(options.wrapWriter ? { wrapWriter: options.wrapWriter } : {})
  stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
  // O alcance do opencode da Maya: terminal amplo (`*`), a skill dela, e o `bash` ligado.
  const reach = new Map([['agent:maya', { name: 'maya', permission: { bash: { '*': 'allow' }, skill: { revisar: 'allow' } }, tools: { bash: true } }]])
  const apply = new ImportApplyUseCase({
    repository,
    readSource,
    scan: {
      inventory: () => ({ scan: { items } as never, reach, agentByName: new Map([['maya', 'agent:maya']]) }),
      catalogState: () => 'new',
    },
    catalog: stack.applier,
    reader: stack.reader,
    models: () => [{ provider: 'google', models: ['gemini-3.7-flash'] }],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
  return { files, repository, stack, apply }
}

const ALL: IImportApplySelection = { keys: ['spec:arq', 'spec:outro', 'skill:revisar', 'agent:maya', 'trigger:maya/revisar', 'rule:commits'], models: MODEL }

describe('ImportApplyUseCase — a gravação do importador pelo catálogo', () => {
  it('aprovado → documento do tipo, com os vínculos: doc, skill com docIds, rule, agente com triggers e contexto inicial', async () => {
    const { apply, stack, repository } = await setup()
    const preview = await apply.preview('alfa', 'j1', ALL)
    assert.deepStrictEqual(preview.skipped, [{ key: 'spec:outro', reason: 'estado pending: só o aprovado é gravado' }])
    assert.strictEqual(preview.scope, 'project:alfa')
    assert.deepStrictEqual(
      preview.plan.items.filter((item) => item.op !== 'create').map((item) => [item.ref, item.op, item.issues]),
      [],
    )
    const doc = (ref: string) => {
      const found = preview.plan.items.find((item) => item.ref === ref)
      assert.ok(found, `sem ${ref}`)
      return found
    }
    doc('spec/arq')
    const ruleRef = preview.plan.items.find((item) => item.kind === 'rule')!.ref
    assert.deepStrictEqual(
      preview.items.map((item) => [item.key, item.refs]),
      [
        ['spec:arq', ['spec/arq']],
        ['skill:revisar', ['skill/revisar']],
        ['agent:maya', ['agent/maya']],
        ['trigger:maya/revisar', ['agent/maya']],
        ['rule:commits', [ruleRef]],
      ],
    )
    assert.deepStrictEqual(
      preview.plan.order.map((step) => `${step.ref}${step.part ? `#${step.part}` : ''}`),
      ['spec/arq', 'skill/revisar', ruleRef, 'agent/maya#record', 'agent/maya#reach'],
    )

    const result = await apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((widening) => widening.key) }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    const skill = stack.reader.read('skill', 'revisar')!
    assert.deepStrictEqual([skill.projectId, skill.body.docIds, skill.body.body], ['alfa', ['arq'], '# Revisar\nLeia `arq` antes.'])
    const rule = stack.reader.read('rule', ruleRef.slice('rule/'.length))!.body
    assert.deepStrictEqual([rule.title, rule.body, rule.position, rule.enabled, rule.projectId], ['Commits', 'Use mensagens claras.', 1, true, 'alfa'])
    // Os itens gravados viram applied: uma prévia nova não os traz de novo.
    assert.deepStrictEqual((await apply.preview('alfa', 'j1', ALL)).items, [])
    // O documento gerado é o canônico do que foi gravado: os mesmos aprovados de novo dão tudo `unchanged`.
    for (const key of ALL.keys!) if (key !== 'spec:outro') repository.updateItem('j1', key, { state: 'approved' })
    const again = await apply.preview('alfa', 'j1', ALL)
    assert.deepStrictEqual(
      again.plan.items.filter((item) => item.op !== 'unchanged').map((item) => [item.ref, item.op, item.diff?.unified]),
      [],
    )
    const maya = stack.reader.read('agent', 'maya')!.body
    assert.deepStrictEqual(maya.initialContext, ['arq'])
    assert.deepStrictEqual(maya.triggers, [{ id: 'revisar', when: 'pedirem revisão', body: 'Quando pedirem revisão, use a skill revisar.' }])
    assert.deepStrictEqual(maya.providers, [{ provider: 'google', models: ['gemini-3.7-flash'] }])
    assert.strictEqual(maya.systemPrompt, 'Você é a Maya.\nContexto em `arq`.')
  })

  it('o agente NASCE FECHADO: as regras amplas do tradutor ficam de fora até a pessoa incluir; cada liberação é uma ampliação listada', async () => {
    const { apply, stack } = await setup()
    const preview = await apply.preview('alfa', 'j1', ALL)
    const maya = preview.agents.find((agent) => agent.key === 'agent:maya')!
    assert.deepStrictEqual(
      maya.rules.map((rule) => [rule.key, !!rule.wide, rule.included]),
      [
        ['terminal allow *', true, false],
        ['skill allow revisar', false, true],
        ['read allow **', true, false],
      ],
    )
    assert.deepStrictEqual([maya.allowedTools, maya.skills, maya.reach], [['cap:terminal', 'cap:files.read'], ['revisar'], 'opencode'])
    const keys = (plan: typeof preview.plan) => plan.widenings.filter((widening) => widening.kind === 'agent').map((widening) => widening.key)
    assert.deepStrictEqual(keys(preview.plan), [
      'agent/maya@alfa#allowedTools+cap:files.read',
      'agent/maya@alfa#allowedTools+cap:terminal',
      'agent/maya@alfa#permissions+allow:skill:revisar',
      'agent/maya@alfa#resources.skills+revisar',
    ])

    // A pessoa inclui o terminal amplo: ele entra, e vira mais uma ampliação a confirmar, uma a uma.
    const wider = await apply.preview('alfa', 'j1', { ...ALL, wide: { 'agent:maya': ['terminal allow *'] } })
    assert.ok(keys(wider.plan).includes('agent/maya@alfa#permissions+allow:terminal:*'))
    assert.notStrictEqual(wider.plan.planHash, preview.plan.planHash)

    // Sem confirm, nada; por token, nunca.
    await assert.rejects(apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash }, ADMIN), CatalogWideningConfirmationError)
    await assert.rejects(
      apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, CI),
      CatalogWideningForbiddenError,
    )
    assert.strictEqual(stack.reader.read('agent', 'maya'), undefined)

    const result = await apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    const agent = stack.agents.entry('maya')!.agent
    assert.deepStrictEqual(agent.permissions, [{ category: 'skill', pattern: 'revisar', decision: 'allow' }])
    assert.deepStrictEqual(stack.reader.read('agent', 'maya')!.body.resources, { skills: ['revisar'], commands: [] })
  })

  it('gravar: os itens viram applied com o lote; o lote guarda a proveniência; parar no alcance deixa o agente fechado e os itens dele aprovados', async () => {
    const { apply, repository, stack } = await setup({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.kind === 'agent' && (target.body.allowedTools as string[]).length) throw new Error('caiu no alcance')
          return writer.prepare(target, current)
        },
      }),
    })
    const preview = await apply.preview('alfa', 'j1', ALL)
    const result = await apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    assert.strictEqual(result.batch?.status, 'partial')
    assert.deepStrictEqual(result.items, { applied: ['spec:arq', 'skill:revisar', 'rule:commits'], notApplied: ['agent:maya', 'trigger:maya/revisar'] })
    const state = (key: string) => [repository.item('j1', key)!.state, repository.item('j1', key)!.batchId]
    assert.deepStrictEqual(state('spec:arq'), ['applied', result.batch!.id])
    assert.deepStrictEqual(state('agent:maya'), ['approved', undefined])
    // O agente entrou FECHADO: sem ferramenta nem permissão.
    const maya = stack.agents.entry('maya')!.agent
    assert.deepStrictEqual([maya.allowedTools, maya.permissions ?? []], [[], []])
    const provenance = result.batch!.summary.provenance as { importJob: string; head: string; items: Array<{ key: string; sources: Array<{ path: string; sha256: string }> }> }
    assert.deepStrictEqual([provenance.importJob, provenance.head], ['j1', 'abc123'])
    assert.deepStrictEqual(provenance.items.find((item) => item.key === 'spec:arq')!.sources, [{ path: '.agents/specs/arq.md', sha256: sha(SOURCES['.agents/specs/arq.md']) }])
  })

  it('rascunho com a fonte mudada no disco: recusa tudo antes de gerar documento', async () => {
    const { apply, files, stack } = await setup()
    files['.agents/specs/arq.md'] = '# Arquitetura\nOutro corpo.\n'
    await assert.rejects(apply.preview('alfa', 'j1', ALL), (error: unknown) => error instanceof ImportBuildError && error.code === 'source_changed')
    assert.strictEqual(stack.reader.read('spec', 'arq'), undefined)
  })

  it('agente novo sem modelo: o plano diz o problema e nada se aplica', async () => {
    const { apply } = await setup()
    const preview = await apply.preview('alfa', 'j1', { keys: ALL.keys })
    const maya = preview.plan.items.find((item) => item.ref === 'agent/maya')!
    assert.strictEqual(maya.op, 'error')
    assert.ok(preview.agents[0].notes.some((note) => note.includes('modelo')))
  })

  it('um lote salvo: só os aprovados dele; sem seleção: todos os aprovados do trabalho', async () => {
    const { apply, repository } = await setup()
    repository.createBatch({ id: 'b1', jobId: 'j1', name: 'docs', prefix: '', keys: ['spec:arq', 'spec:outro'], order: ['spec:arq', 'spec:outro'], by: 'ana', at: new Date() })
    const batch = await apply.preview('alfa', 'j1', { batchId: 'b1' })
    assert.deepStrictEqual(
      batch.items.map((item) => item.key),
      ['spec:arq'],
    )
    const all = await apply.preview('alfa', 'j1', { models: MODEL })
    assert.deepStrictEqual(all.skipped, [])
    assert.strictEqual(all.items.length, 5)
  })
})
