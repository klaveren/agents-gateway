import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { CatalogWideningConfirmationError, CatalogWideningForbiddenError } from '@domain/errors/Domain.Error'
import { IInventoryItem, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { buildCatalogStack } from '../testing/Catalog.Fixture'
import type { ICatalogWriter } from './Catalog.Writer'
import { IImportApplySelection, ImportApplyUseCase, missingRefs } from './ImportApply.Usecase'
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
  '.agents/specs/guia.md': '# Guia\nVeja `.agents/commands/lint.md`, `.agents/memoria.md` e `.agents/specs/longa.md`.\n',
  '.agents/specs/longa.md': '# Longa\n',
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Um repositório sintético (em memória), o trabalho com os itens, o construtor, o catálogo e a gravação. */
async function setup(
  options: {
    wrapWriter?: (writer: ICatalogWriter) => ICatalogWriter
    withFiles?: boolean
    /** O alcance do opencode da Maya no lugar do padrão; e o agente `agent-sre` e o MCP `fantasma` no trabalho. */
    reach?: { permission: Record<string, unknown>; tools: Record<string, boolean> }
    extra?: boolean
  } = {},
) {
  const files: Record<string, string> = {
    ...SOURCES,
    ...(options.extra ? { '.agents/agents/agent-sre/prompt.md': 'Você é o SRE.\n', 'opencode.json#mcp.fantasma': '{"type":"local"}\n' } : {}),
    ...(options.withFiles
      ? {
          '.agents/skills/revisar/run.sh': '#!/bin/sh\necho revisar\n',
          '.agents/agents/maya/scripts/saldo.mjs': 'console.log(1)\n',
          '.agents/agents/maya/scripts/chave.mjs': 'const k = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"\n',
        }
      : {}),
  }
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
    item('spec:guia', '.agents/specs/guia.md'),
    item('spec:longa', '.agents/specs/longa.md'),
    // ⚠️ O MCP que a varredura viu no gateway (`global`) e que não está mais lá: o tradutor o mapeia mesmo assim.
    ...(options.extra
      ? [item('agent:agent-sre', '.agents/agents/agent-sre/prompt.md'), { ...item('mcp:fantasma', 'opencode.json#mcp.fantasma'), catalog: 'global' as const }]
      : []),
  ]
  if (options.withFiles) {
    // A skill com o script dela (vai como arquivo, fora do rascunho); a pasta scripts/ do agente, que a varredura deixa de fora.
    const source = (path: string, role?: string) => ({ path, aliases: [], bytes: Buffer.byteLength(files[path]), tokens: 1, sha256: sha(files[path]), ...(role ? { role } : {}) })
    const skill = items.find((entry) => entry.key === 'skill:revisar')!
    skill.sources = [source('.agents/skills/revisar/SKILL.md', 'skill'), source('.agents/skills/revisar/run.sh', 'attachment')]
    items.push({
      ...item('skip:.agents/agents/maya/scripts', '.agents/agents/maya/scripts/saldo.mjs'),
      sources: [source('.agents/agents/maya/scripts/saldo.mjs'), source('.agents/agents/maya/scripts/chave.mjs')],
    })
  }
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
      totals: { files: 8, items: 8, tokens: 8, byKind: {} },
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
  // O guia cita um command do catálogo, um arquivo de memória (nada no catálogo) e outra spec, por referência. ⚠️ O
  // construtor de hoje já recusa vínculo com item do trabalho que não é documento; o rascunho antigo não passou por isso.
  const quote = (text: string, target: string, link: string) => ({ op: 'linkCitation', text, target, link })
  await propose(['spec:guia', 'spec:longa'], {
    'spec:guia': {
      meta: { id: 'guia', title: 'Guia', summary: 'O guia' },
      ops: [quote('.agents/commands/lint.md', 'lint', 'attach'), quote('.agents/memoria.md', 'memoria', 'attach'), quote('.agents/specs/longa.md', 'longa', 'reference')],
    },
    'spec:longa': { meta: { id: 'longa', title: 'Longa', summary: 'A longa' } },
  })

  if (options.extra) await propose(['agent:agent-sre'], { 'agent:agent-sre': { meta: { id: 'agent-sre', name: 'SRE' } } })

  // O depósito em memória: o conteúdo por sha, e a pasta de cada recurso (o que a gravação escreveria).
  const depot = new Map<string, Buffer>()
  const folders = new Map<string, string[]>()
  const filesPort = {
    has: (hash: string) => depot.has(hash),
    put: (content: Buffer) => {
      const hash = createHash('sha256').update(content).digest('hex')
      depot.set(hash, content)
      return { sha256: hash, bytes: content.length }
    },
    read: (hash: string) => depot.get(hash),
    dirOf: (kind: string, id: string) => `/dados/${kind}/${id}`,
    sync: (kind: string, id: string, _projectId: string | undefined, list: ReadonlyArray<{ path: string }>) =>
      void folders.set(
        `${kind}/${id}`,
        list.map((file) => file.path),
      ),
    remove: (kind: string, id: string) => void folders.delete(`${kind}/${id}`),
    writeAgent: (id: string, _projectId: string | undefined, list: ReadonlyArray<{ path: string }>, removed: readonly string[]) =>
      void folders.set(`agent/${id}`, [...new Set([...(folders.get(`agent/${id}`) ?? []).filter((path) => !removed.includes(path)), ...list.map((file) => file.path)])]),
    restoreAgent: () => undefined,
    moveAgent: () => undefined,
    snapshotAgent: () => [],
  }
  const stack = buildCatalogStack({ ...(options.wrapWriter ? { wrapWriter: options.wrapWriter } : {}), ...(options.withFiles ? { files: filesPort } : {}) })
  stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
  // O alcance do opencode da Maya: terminal amplo (`*`), a skill dela, e o `bash` ligado.
  const reach = new Map([['agent:maya', { name: 'maya', ...(options.reach ?? { permission: { bash: { '*': 'allow' }, skill: { revisar: 'allow' } }, tools: { bash: true } }) }]])
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
    ...(options.withFiles
      ? {
          readRaw: (_projectId: string, _repository: string, path: string) => (path in files ? Buffer.from(files[path]) : undefined),
          files: filesPort,
          secretsIn: (text: string) => (/ghp_/.test(text) ? ['token'] : []),
        }
      : {}),
  })
  return { files, repository, stack, apply, depot, folders }
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

  it('⛔ aprovado antes das regras de hoje (resumo acima do limite): fica de fora da gravação, com o motivo', async () => {
    const { apply, repository } = await setup()
    const entry = repository.item('j1', 'spec:arq')!
    const draft = entry.drafts.at(-1) as { outputs: Array<{ meta: Record<string, string> }> }
    repository.updateItem('j1', 'spec:arq', { drafts: [{ ...draft, outputs: draft.outputs.map((output) => ({ ...output, meta: { ...output.meta, summary: 'x'.repeat(400) } })) }] })
    const preview = await apply.preview('alfa', 'j1', ALL)
    const skipped = preview.skipped.find((one) => one.key === 'spec:arq')
    assert.match(skipped?.reason ?? '', /não passa nas regras de hoje.*peça ajuste/)
    assert.ok(!preview.items.some((item) => item.key === 'spec:arq'))
  })

  it('agente novo sem modelo: o plano diz o problema e nada se aplica', async () => {
    const { apply } = await setup()
    const preview = await apply.preview('alfa', 'j1', { keys: ALL.keys })
    const maya = preview.plan.items.find((item) => item.ref === 'agent/maya')!
    assert.strictEqual(maya.op, 'error')
    assert.ok(preview.agents[0].notes.some((note) => note.includes('modelo')))
  })

  it('⚖️ modelo da assinatura (só a lane agent): o agente entra só com o modo agent, e o plano não recusa', async () => {
    const { apply } = await setup()
    const preview = await apply.preview('alfa', 'j1', { ...ALL, models: { 'agent:maya': { provider: 'claude-sub', model: 'claude-opus-5-5' } } })
    const maya = preview.plan.items.find((item) => item.ref === 'agent/maya')!
    assert.deepStrictEqual(
      maya.issues.filter((issue) => issue.field === 'modes'),
      [],
    )
    assert.ok(preview.agents[0].notes.some((note) => note.includes('só no modo agente')))
  })

  it('só os prontos (`ready`): o bloqueado fica de fora com o motivo; o resto grava', async () => {
    const { apply, repository } = await setup()
    const selection = { keys: ALL.keys, ready: true }
    const preview = await apply.preview('alfa', 'j1', selection)
    assert.deepStrictEqual(
      preview.plan.items.filter((item) => item.op === 'error' || item.op === 'conflict'),
      [],
    )
    const held = preview.heldBack.map((one) => one.key).sort()
    assert.ok(held.includes('agent:maya'), JSON.stringify(preview.heldBack))
    assert.ok(preview.heldBack.every((one) => one.reason.length > 0))
    assert.ok(!preview.items.some((item) => held.includes(item.key)))
    const result = await apply.apply('alfa', 'j1', { ...selection, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    assert.ok(result.items.applied.includes('spec:arq'))
    assert.deepStrictEqual([...result.items.notApplied].sort(), held)
    assert.strictEqual(repository.item('j1', 'agent:maya')!.state, 'approved')
    assert.strictEqual(repository.item('j1', 'spec:arq')!.state, 'applied')
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
    assert.strictEqual(all.items.length, 7)
  })

  it('⛔ o aprovado que SAIU DA FONTE fica de fora, com o motivo; a gravação dos outros não falha por falta da fonte', async () => {
    const { apply, repository, files } = await setup()
    delete files['.agents/specs/guia.md']
    repository.reanalyze({
      jobId: 'j1',
      scannedAt: new Date('2026-10-30T11:00:00.000Z'),
      by: 'ana',
      inventory: repository.get('alfa', 'j1')!.inventory,
      present: [],
      gone: ['spec:guia'],
      analysis: { at: new Date('2026-10-30T11:00:00.000Z'), by: 'ana', kept: 0, stale: [], added: [], gone: ['spec:guia'], restored: [], returned: [] },
    })
    assert.strictEqual(repository.item('j1', 'spec:guia')!.state, 'approved', 'continua aprovado: nada é desfeito')
    const all = await apply.preview('alfa', 'j1', { models: MODEL })
    assert.deepStrictEqual(all.skipped, [{ key: 'spec:guia', reason: 'saiu da fonte: o item não está mais no repositório' }])
    assert.strictEqual(all.items.length, 6)
    assert.ok(!all.items.some((one) => one.key === 'spec:guia'))
  })

  it('a skill sem a spec selecionada NÃO bloqueia: entra sem o vínculo, com `link-pending` (nada falta no plano)', async () => {
    const { apply } = await setup()
    const preview = await apply.preview('alfa', 'j1', { keys: ['skill:revisar'] })
    assert.deepStrictEqual(preview.missing, [])
    assert.deepStrictEqual(
      preview.plan.items.map((item) => [item.ref, item.op]),
      [['skill/revisar', 'create']],
    )
    assert.deepStrictEqual(preview.items[0].issues, [
      {
        code: 'link-pending',
        message: 'vínculo com arq pendente: arq ainda não está no catálogo (volta sozinho quando arq for importado)',
        target: 'arq',
        link: 'attach',
        ref: 'skill/revisar',
      },
    ])
    // Com a spec no pacote, o vínculo vale.
    const both = await apply.preview('alfa', 'j1', { keys: ['skill:revisar', 'spec:arq'] })
    assert.deepStrictEqual([both.missing, both.items.map((item) => item.issues)], [[], [undefined, undefined]])
  })
})

describe('ImportApplyUseCase — os problemas da importação (não bloqueiam, ficam no artefato)', () => {
  const write = async (apply: ImportApplyUseCase, selection: IImportApplySelection) => {
    const preview = await apply.preview('alfa', 'j1', selection)
    const result = await apply.apply('alfa', 'j1', { ...selection, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    return { preview, result }
  }

  it('o vínculo com o que não é documento (um command), com o que não existe, e com o doc do trabalho fora da seleção: grava sem ele, com o problema no doc', async () => {
    const { apply, stack } = await setup()
    stack.guidance.createResource({ id: 'lint', kind: 'command', projectId: 'alfa', description: 'Roda o lint', body: 'lint' }, 'ana')
    const { preview, result } = await write(apply, { keys: ['spec:guia'] })
    assert.deepStrictEqual(
      preview.plan.items.map((item) => [item.ref, item.op]),
      [['spec/guia', 'create']],
    )
    assert.strictEqual(result.batch?.status, 'applied')
    const guia = stack.guidance.doc('guia')
    assert.deepStrictEqual([guia.docIds, guia.docRefs], [[], undefined])
    assert.deepStrictEqual(
      guia.importIssues?.map((issue) => [issue.code, issue.target, issue.link]),
      [
        ['link-not-document', 'lint', 'attach'],
        ['link-missing', 'memoria', 'attach'],
        ['link-pending', 'longa', 'reference'],
      ],
    )
    assert.match(guia.importIssues![0].message, /lint, que é um command: não vira vínculo/)
    // A citação fica no texto; o problema vai no documento canônico (histórico, export).
    assert.match(guia.body, /Veja `lint`, `memoria` e `longa`/)
    assert.strictEqual((stack.reader.read('spec', 'guia')!.body.importIssues as unknown[]).length, 3)
  })

  it('a cascata não segura ninguém: o bloqueado de verdade fica de fora (`ready`), quem o cita entra com `link-pending`; sem `ready`, só ele é erro', async () => {
    const { apply, stack } = await setup()
    // Um doc `longa` de outro projeto: o id já existe fora do escopo — conflito, bloqueio de verdade.
    stack.projects.create({ id: 'beta', name: 'Beta' }, 'ana')
    stack.guidance.createDoc({ id: 'longa', kind: 'spec', projectId: 'beta', title: 'Longa', summary: 'De outro', body: 'x' }, 'ana')
    const keys = ['spec:guia', 'spec:longa']
    const all = await apply.preview('alfa', 'j1', { keys })
    assert.deepStrictEqual(
      all.plan.items.map((item) => [item.ref, item.op]),
      [
        ['spec/guia', 'create'],
        ['spec/longa', 'conflict'],
      ],
    )
    const ready = await apply.preview('alfa', 'j1', { keys, ready: true })
    assert.deepStrictEqual(
      ready.heldBack.map((one) => one.key),
      ['spec:longa'],
    )
    const issue = ready.items.find((item) => item.key === 'spec:guia')!.issues!.find((one) => one.target === 'longa')
    // ⚖️ Existe no catálogo, mas em outro projeto: não é pendente, é de escopo.
    assert.deepStrictEqual([issue?.code, issue?.link], ['link-scope', 'reference'])
  })

  it('auto-resolve: a importação seguinte que grava o doc pendente devolve o vínculo (com o histórico) e tira o problema', async () => {
    const { apply, stack } = await setup()
    await write(apply, { keys: ['skill:revisar'] })
    assert.deepStrictEqual(stack.guidance.resource('revisar').docIds, [])
    const { preview, result } = await write(apply, { keys: ['spec:arq'] })
    assert.deepStrictEqual(preview.resolved, [
      {
        ref: 'skill/revisar',
        issues: [
          { code: 'link-pending', message: 'vínculo com arq pendente: arq ainda não está no catálogo (volta sozinho quando arq for importado)', target: 'arq', link: 'attach' },
        ],
      },
    ])
    assert.deepStrictEqual(
      result.applied.map((step) => step.ref),
      ['spec/arq', 'skill/revisar'],
    )
    const skill = stack.guidance.resource('revisar')
    assert.deepStrictEqual([skill.docIds, skill.importIssues], [['arq'], undefined])
    const revisions = stack.repository.revisions('skill', 'revisar')
    assert.deepStrictEqual(
      revisions.map((revision) => [revision.op, revision.source]),
      [
        ['import', 'import'],
        ['import', 'import'],
      ],
    )
    // O guia com `longa` por referência: volta em docIds E em docRefs.
    stack.guidance.createResource({ id: 'lint', kind: 'command', projectId: 'alfa', description: 'Roda o lint', body: 'lint' }, 'ana')
    await write(apply, { keys: ['spec:guia'] })
    await write(apply, { keys: ['spec:longa'] })
    const guia = stack.guidance.doc('guia')
    assert.deepStrictEqual([guia.docIds, guia.docRefs, guia.importIssues?.map((one) => one.code)], [['longa'], ['longa'], ['link-not-document', 'link-missing']])
  })

  it('a skill liberada que ainda não está no catálogo vira `skill-missing` no agente; gravada depois, entra em `resources.skills` (com a ampliação confirmada)', async () => {
    const { apply, stack } = await setup()
    const first = await write(apply, { keys: ['spec:arq', 'agent:maya', 'trigger:maya/revisar'], models: MODEL })
    assert.deepStrictEqual(first.preview.agents[0].pendingSkills, ['revisar'])
    const maya = () => stack.agents.entry('maya')!.agent
    assert.deepStrictEqual(
      maya().importIssues?.map((one) => [one.code, one.target, one.link]),
      [['skill-missing', 'revisar', 'skill']],
    )
    assert.deepStrictEqual(stack.reader.read('agent', 'maya')!.body.resources, { skills: [], commands: [] })
    const second = await write(apply, { keys: ['skill:revisar'] })
    assert.ok(second.preview.plan.widenings.some((one) => one.key === 'agent/maya@alfa#resources.skills+revisar'))
    assert.deepStrictEqual(stack.reader.read('agent', 'maya')!.body.resources, { skills: ['revisar'], commands: [] })
    assert.strictEqual(maya().importIssues, undefined)
  })
})

describe('ImportApplyUseCase — o alcance que cita o que não existe (`delegate-missing`, `mcp-missing`)', () => {
  // O administrador do opencode: delega a um agente que não existe, a um curinga, nega um terceiro e usa um MCP sumido.
  const REACH = {
    permission: {
      bash: { 'git status': 'allow' },
      task: { 'agent-sre': 'allow', 'ops-*': 'allow', 'agent-velho': 'deny' },
      mcp: { fantasma_buscar: 'allow' },
    },
    tools: { bash: true, fantasma_buscar: true },
  }
  const MAYA = { keys: ['agent:maya', 'trigger:maya/revisar'], models: MODEL }
  const agentKeys = (plan: { widenings: Array<{ kind: string; id: string; key: string }> }, id = 'maya') =>
    plan.widenings.filter((widening) => widening.kind === 'agent' && widening.id === id).map((widening) => widening.key)

  it('a liberação exata a quem não existe sai e fica guardada no agente (não vira ampliação); curinga, negar, terminal e `cap:` seguem', async () => {
    const { apply, stack } = await setup({ reach: REACH, extra: true })
    const preview = await apply.preview('alfa', 'j1', MAYA)
    assert.deepStrictEqual(agentKeys(preview.plan), [
      'agent/maya@alfa#allowedTools+cap:files.read',
      'agent/maya@alfa#allowedTools+cap:terminal',
      'agent/maya@alfa#permissions+allow:delegate:ops-*',
      'agent/maya@alfa#permissions+allow:terminal:git status',
    ])
    const view = preview.agents.find((agent) => agent.key === 'agent:maya')!
    assert.deepStrictEqual(
      view.rules.filter((rule) => rule.held).map((rule) => rule.key),
      ['delegate allow agent-sre', 'mcp allow fantasma/buscar'],
    )
    assert.deepStrictEqual(view.allowedTools, ['cap:terminal', 'cap:files.read'])
    // A lista amarela da gravação mostra o que ficou de fora (e por quê a lista de ampliações encolheu).
    const issues = preview.items.find((item) => item.key === 'agent:maya')!.issues!.filter((one) => one.link === 'reach')
    assert.deepStrictEqual(
      issues.map((one) => [one.ref, one.code, one.target]),
      [
        ['agent/maya', 'delegate-missing', 'agent-sre'],
        ['agent/maya', 'mcp-missing', 'fantasma'],
      ],
    )
    assert.match(issues[0].message, /^permite delegar a agent-sre, que ainda não existe/)

    const result = await apply.apply('alfa', 'j1', { ...MAYA, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    const maya = stack.agents.entry('maya')!.agent
    assert.deepStrictEqual(maya.permissions, [
      { category: 'terminal', pattern: 'git status', decision: 'allow' },
      { category: 'delegate', pattern: 'ops-*', decision: 'allow' },
      { category: 'delegate', pattern: 'agent-velho', decision: 'deny' },
    ])
    assert.deepStrictEqual(maya.allowedTools, ['cap:files.read', 'cap:terminal'])
    assert.deepStrictEqual(
      maya.importIssues?.filter((one) => one.link === 'reach').map((one) => [one.code, one.target, one.rules, one.tools]),
      [
        ['delegate-missing', 'agent-sre', [{ category: 'delegate', pattern: 'agent-sre', decision: 'allow', note: 'alvo ainda não importado' }], undefined],
        ['mcp-missing', 'fantasma', [{ category: 'mcp', pattern: 'fantasma/buscar', decision: 'allow' }], ['mcp:fantasma/buscar']],
      ],
    )
  })

  it('o alvo entra NA MESMA gravação: a regra fica, e é ampliação a confirmar como sempre', async () => {
    const { apply } = await setup({ reach: REACH, extra: true })
    const preview = await apply.preview('alfa', 'j1', { keys: [...MAYA.keys, 'agent:agent-sre'], models: { ...MODEL, 'agent:agent-sre': MODEL['agent:maya'] } })
    assert.ok(agentKeys(preview.plan).includes('agent/maya@alfa#permissions+allow:delegate:agent-sre'))
    assert.deepStrictEqual(
      preview.items
        .find((item) => item.key === 'agent:maya')!
        .issues!.filter((one) => one.link === 'reach')
        .map((one) => one.code),
      ['mcp-missing'],
    )
  })

  it('auto-resolve: a importação seguinte que grava o agente devolve a regra como AMPLIAÇÃO — sem a caixa, nada entra', async () => {
    const { apply, stack } = await setup({ reach: REACH, extra: true })
    const first = await apply.preview('alfa', 'j1', MAYA)
    await apply.apply('alfa', 'j1', { ...MAYA, planHash: first.plan.planHash, confirm: first.plan.widenings.map((one) => one.key) }, ADMIN)

    const sre = { keys: ['agent:agent-sre'], models: { 'agent:agent-sre': MODEL['agent:maya'] } }
    const preview = await apply.preview('alfa', 'j1', sre)
    assert.deepStrictEqual(
      preview.resolved.map((one) => [one.ref, one.issues.map((issue) => issue.code)]),
      [['agent/maya', ['delegate-missing']]],
    )
    assert.deepStrictEqual(agentKeys(preview.plan), ['agent/maya@alfa#permissions+allow:delegate:agent-sre'])
    // ⛔ O confirm tem de trazer a ampliação da regra que volta.
    const others = preview.plan.widenings.map((one) => one.key).filter((key) => !key.startsWith('agent/maya'))
    await assert.rejects(apply.apply('alfa', 'j1', { ...sre, planHash: preview.plan.planHash, confirm: others }, ADMIN), CatalogWideningConfirmationError)
    assert.strictEqual(
      stack.agents.entry('maya')!.agent.permissions?.some((rule) => rule.pattern === 'agent-sre'),
      false,
    )

    await apply.apply('alfa', 'j1', { ...sre, planHash: preview.plan.planHash, confirm: preview.plan.widenings.map((one) => one.key) }, ADMIN)
    const maya = stack.agents.entry('maya')!.agent
    assert.deepStrictEqual(maya.permissions?.at(-1), { category: 'delegate', pattern: 'agent-sre', decision: 'allow' })
    assert.deepStrictEqual(
      maya.importIssues?.map((one) => one.code),
      ['link-pending', 'skill-missing', 'mcp-missing'],
    )
  })

  it('descartar: um (código e alvo) ou todos os pendentes de uma vez; o guardado é esquecido, e a revisão vai para o histórico', async () => {
    const { apply, stack } = await setup({ reach: REACH, extra: true })
    const first = await apply.preview('alfa', 'j1', MAYA)
    await apply.apply('alfa', 'j1', { ...MAYA, planHash: first.plan.planHash, confirm: first.plan.widenings.map((one) => one.key) }, ADMIN)
    const revisions = () => stack.repository.revisions('agent', 'maya').length
    const before = revisions()

    stack.agents.resolveImportIssue('maya', { code: 'mcp-missing', target: 'fantasma' }, 'root@x.test')
    assert.deepStrictEqual(
      stack.agents.entry('maya')!.agent.importIssues?.map((one) => one.code),
      ['link-pending', 'skill-missing', 'delegate-missing'],
    )
    stack.agents.resolveImportIssue('maya', { pending: true }, 'root@x.test')
    assert.strictEqual(stack.agents.entry('maya')!.agent.importIssues, undefined)
    assert.strictEqual(revisions(), before + 2)
    assert.strictEqual(stack.repository.revisions('agent', 'maya').at(-1)?.by, 'root@x.test')
    assert.throws(() => stack.agents.resolveImportIssue('maya', { pending: true }, 'root@x.test'), /pending issues in agent maya/)

    // O agente gravado depois não devolve nada: o que foi descartado não volta.
    const sre = { keys: ['agent:agent-sre'], models: { 'agent:agent-sre': MODEL['agent:maya'] } }
    const preview = await apply.preview('alfa', 'j1', sre)
    assert.deepStrictEqual([preview.resolved, agentKeys(preview.plan)], [[], []])
  })
})

describe('ImportApplyUseCase — os arquivos de recurso que a importação leva', () => {
  it('a skill leva o script (fora do rascunho); o agente, a pasta scripts/ — o que tem segredo fica de fora, com o motivo', async () => {
    const { apply } = await setup({ withFiles: true })
    const preview = await apply.preview('alfa', 'j1', ALL)
    const skipped = preview.skipped.map((entry) => `${entry.key} ${entry.reason}`)
    assert.ok(
      skipped.some((line) => /^agent:maya arquivo \.agents\/agents\/maya\/scripts\/chave\.mjs fica de fora: parece ter segredo/.test(line)),
      skipped.join('\n'),
    )
    assert.ok(!skipped.some((line) => /run\.sh|saldo\.mjs/.test(line)))
  })

  it('gravar: o conteúdo entra no depósito antes, e a pasta da skill e do agente é escrita', async () => {
    const { apply, folders, depot } = await setup({ withFiles: true })
    const preview = await apply.preview('alfa', 'j1', ALL)
    const confirm = preview.plan.widenings.map((widening) => widening.key)
    await apply.apply('alfa', 'j1', { ...ALL, planHash: preview.plan.planHash, confirm }, ADMIN)
    assert.deepStrictEqual(folders.get('skill/revisar'), ['run.sh'])
    assert.deepStrictEqual(folders.get('agent/maya'), ['scripts/saldo.mjs'])
    assert.strictEqual(depot.size, 2)
  })
})

describe('missingRefs', () => {
  const entry = (key: string, candidateId: string, extra: Record<string, unknown> = {}) =>
    ({ key, item: { key, kind: key.split(':')[0], candidateId, sources: [{ path: `src/${candidateId}.md` }] }, state: 'pending', drafts: [], ...extra }) as never
  const broken = (from: string, target: string, id: string, reason = 'missing') => ({ from, field: 'docIds', target, id, reason, message: '' })
  const plan = (...refs: ReturnType<typeof broken>[]) => ({ items: [{ brokenRefs: refs }] }) as never

  it('casa pelo tipo e pelo id (o escolhido, o proposto com prefixo); junta quem cita; sem item, diz que não vem daqui', () => {
    const items = [entry('skill:plano', 'plano'), entry('spec:plano', 'plano'), entry('knowledge:guia', 'guia', { targetId: 'guia-novo' })]
    const found = missingRefs(
      plan(
        broken('knowledge/a', 'doc', 'plano'),
        broken('knowledge/b', 'doc', 'plano'),
        broken('knowledge/a', 'doc', 'guia-novo'),
        broken('knowledge/a', 'doc', 'sumiu'),
        broken('agent/x', 'mcp', 'off', 'disabled'),
      ),
      items,
      '',
    )
    assert.deepStrictEqual(
      found.map((one) => [one.id, one.from, one.item?.key]),
      [
        ['plano', ['knowledge/a', 'knowledge/b'], 'spec:plano'],
        ['guia-novo', ['knowledge/a'], 'knowledge:guia'],
        ['sumiu', ['knowledge/a'], undefined],
      ],
    )
    assert.strictEqual(missingRefs(plan(broken('k/a', 'spec', 'pre-plano')), items, 'pre-').at(0)?.item?.key, 'spec:plano')
    // Um command com o id citado como doc: o vínculo está errado (não falta nada), e diz quem cita.
    const wrong = missingRefs(plan(broken('spec/arq', 'doc', 'drain')), [entry('command:drain', 'drain')], '', { 'spec:arq': ['spec/arq'] })
    assert.deepStrictEqual(wrong, [{ target: 'doc', id: 'drain', from: ['spec/arq'], fromKeys: ['spec:arq'], wrongKind: { key: 'command:drain', kind: 'command' } }])
  })
})
