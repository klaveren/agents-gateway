import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { maskText } from '@domain/Secret.Mask'
import { IImportPlan } from '@domain/models/ImportPlan.Model'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { builderProtocolTokens, ImportPlanError, ImportPlanUseCase } from './ImportPlan.Usecase'
import { catalogFinder, ImportScanUseCase } from './ImportScan.Usecase'
import { writeBatchFixture } from '../testing/Import.Fixture'

describe('ImportPlanUseCase — o lote de um agente sobre a varredura real (só leitura)', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-import-plan-'))
  const root = join(base, 'repo')
  let scan: ImportScanUseCase
  let usecase: ImportPlanUseCase
  let plan: IImportPlan

  before(() => {
    mkdirSync(root, { recursive: true })
    writeBatchFixture(root)
    scan = new ImportScanUseCase({
      readTree: () => readRepoTree(root, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector()],
      findInCatalog: catalogFinder({
        doc: (id) => (id === 'colide' || id === 'akm-base' ? { projectId: 'outro' } : undefined),
        resource: (id) => (id === 'akm-revisar' ? { projectId: 'alfa' } : undefined),
        rules: () => [],
        agent: (id) => (id === 'caio' ? { projectId: 'alfa' } : undefined),
        mcpServer: (id) => id === 'github',
      }),
    })
    usecase = new ImportPlanUseCase({ scan, now: () => new Date('2026-10-30T12:00:00Z') })
    plan = usecase.execute('alfa', { repository: 'repo', agent: 'ana' })
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  it('a varredura não junta dois agentes porque os bootstraps gerados declaram a mesma spec', () => {
    const items = scan.execute('alfa', 'repo').items
    assert.ok(items.some((item) => item.key === 'agent:ana') && items.some((item) => item.key === 'agent:bia'))
    assert.ok(!items.find((item) => item.key === 'agent:ana')!.sources.some((source) => source.path.includes('/bia/')))
  })

  it('ledger, memória e o índice dos triggers do agente ficam fora do catálogo', () => {
    const items = scan.execute('alfa', 'repo').items
    const ana = items.find((item) => item.key === 'agent:ana')!
    assert.ok(!ana.sources.some((source) => /ledger|memory|README/.test(source.path)))
    assert.ok(items.some((item) => item.key === 'skip:.agents/agents/ana/ana-ledger'))
    assert.ok(items.some((item) => item.key === 'skip:.agents/agents/ana/ana-memory.md'))
  })

  it('instructions com glob: expande dentro da raiz; para fora e vazio viram alerta', () => {
    const config = scan.execute('alfa', 'repo').items.find((item) => item.key === 'config:opencode')!
    assert.ok(config.refs.some((ref) => ref.path === '.agents/specs/inst-um.md' && ref.item === 'spec:inst-um'))
    assert.ok(config.notes.some((note) => note.code === 'instructions-glob' && note.text.includes('1 arquivo')))
    assert.ok(config.notes.some((note) => note.code === 'instructions-outside' && note.text.includes('../*.md')))
    assert.ok(config.notes.some((note) => note.code === 'instructions-glob-empty' && note.text.includes('nada/*.md')))
    assert.strictEqual(plan.steps.find((step) => step.key === 'spec:inst-um')?.why, 'instructions')
  })

  it('o fecho em ordem: docs, skills e commands, rule, agente e triggers; ciclo e citação quebrada reportados', () => {
    assert.deepStrictEqual(
      plan.steps.map((step) => `${step.phase} ${step.key}`),
      [
        '1 knowledge:fila',
        '1 spec:colide',
        '1 spec:base',
        '1 spec:guia',
        '1 spec:inst-um',
        '1 spec:ciclo-a',
        '1 spec:ciclo-b',
        '2 skill:akm-revisar',
        '2 skill:solta',
        '2 command:publicar',
        '3 rule:regras',
        '4 agent:ana',
        '4 trigger:ana/01-revisar',
        '4 trigger:ana/02-ciclo',
      ],
    )
    assert.deepStrictEqual(
      plan.cycles.map((cycle) => cycle.keys),
      [['spec:ciclo-a', 'spec:ciclo-b']],
    )
    assert.ok(plan.excluded.some((entry) => entry.reason === 'broken' && entry.path === '.agents/specs/sumiu.md'))
    assert.ok(plan.excluded.some((entry) => entry.reason === 'untranslatable' && entry.code === 'command-agent'))
    assert.ok(plan.excluded.some((entry) => entry.reason === 'other-agent' && entry.item === 'agent:bia'))
  })

  it('o alcance ligado ao tradutor: regras, ampliações, allowedTools e resources.skills', () => {
    const reach = plan.reach!
    assert.strictEqual(reach.sourceName, 'ana')
    assert.deepStrictEqual(reach.translation.allowedTools, ['cap:terminal', 'cap:files.read', 'mcp:github/list', 'agent:caio'])
    assert.ok(reach.translation.widenings.some((widening) => widening.rule.category === 'terminal' && widening.rule.pattern === '*'))
    assert.deepStrictEqual(reach.skills.proposed, ['akm-outra', 'akm-revisar'])
    assert.deepStrictEqual(reach.skills.notReleased, ['solta'])
    assert.deepStrictEqual(
      plan.released.map((one) => one.key),
      ['skill:akm-outra'],
    )
    assert.ok(plan.project!.widenings.some((widening) => widening.rule.category === 'skill' && widening.rule.pattern === '*'))
    assert.deepStrictEqual(
      plan.links.map((link) => [link.name, link.state, link.cycle]),
      [
        ['bia', 'pending', true],
        ['caio', 'exists', false],
      ],
    )
  })

  it('a estimativa: uma conversa por item a importar; o agente não conta o bootstrap gerado nem o ledger', () => {
    // 14 passos; a skill que já existe neste projeto (`akm-revisar`) fica na ordem, marcada, sem conversa.
    assert.strictEqual(plan.steps.length, 14)
    assert.strictEqual(plan.estimate.conversations, 13)
    assert.strictEqual(plan.estimate.done, 1)
    const agent = plan.steps.find((step) => step.key === 'agent:ana')!
    assert.ok(agent.tokens.sources < 200, `o agente leria ${agent.tokens.sources} tokens`)
    const protocol = builderProtocolTokens()
    assert.strictEqual(agent.tokens.protocol, protocol('agent'))
    assert.strictEqual(plan.steps.find((step) => step.kind === 'trigger')!.tokens.protocol, protocol('agent'))
    assert.ok(protocol('spec') > 500)
    assert.strictEqual(plan.estimate.inputTokens, plan.estimate.sourceTokens + plan.estimate.protocolTokens)
  })

  it('mapa de ids: a colisão bloqueia; o prefixo muda o id e a colisão passa a ser a do id novo', () => {
    assert.deepStrictEqual(plan.blocked, ['spec:colide: o id colide já existe em outro projeto: mude antes de transformar'])
    assert.strictEqual(plan.idMap.find((entry) => entry.key === 'skill:akm-revisar')?.state, 'update')
    const prefixed = usecase.execute('alfa', { repository: 'repo', agent: 'agent:ana', prefix: 'AKM-' })
    assert.strictEqual(prefixed.prefix, 'akm-')
    const ids = Object.fromEntries(prefixed.idMap.map((entry) => [entry.key, `${entry.id} ${entry.state}`]))
    assert.strictEqual(ids['spec:colide'], 'akm-colide new')
    assert.strictEqual(ids['spec:base'], 'akm-base conflict')
    assert.strictEqual(ids['skill:akm-revisar'], 'akm-akm-revisar new')
    assert.strictEqual(ids['rule:regras'], 'regras new')
    assert.strictEqual(ids['agent:ana'], 'akm-ana new')
    assert.deepStrictEqual(prefixed.blocked, ['spec:base: o id akm-base já existe em outro projeto: mude antes de transformar'])
    // O alvo que existe como `caio` não existe como `akm-caio`: o vínculo volta a ficar pendente.
    assert.strictEqual(prefixed.links.find((link) => link.name === 'caio')?.state, 'pending')
  })

  it('lote do agente enxuto: o que já está no catálogo do projeto e o aprovado no trabalho saem das conversas e da estimativa', () => {
    const revisar = plan.steps.find((step) => step.key === 'skill:akm-revisar')!
    assert.deepStrictEqual([revisar.state, revisar.done], ['update', 'catalog'])
    assert.ok(plan.notes.some((note) => note.code === 'done' && note.text.includes('1 já no catálogo')))
    assert.ok(!plan.estimate.byKind.skill || plan.estimate.byKind.skill.conversations === 1)
    assert.strictEqual(plan.phases.find((phase) => phase.phase === 2)!.steps, 2)

    const states = new Map([
      ['spec:guia', 'approved' as const],
      ['knowledge:fila', 'applied' as const],
      ['spec:base', 'pending' as const],
    ])
    const withJob = new ImportPlanUseCase({
      scan,
      jobStates: (projectId, jobId) => (projectId === 'alfa' && jobId === 'j1' ? { repository: 'repo', states } : undefined),
    }).execute('alfa', { repository: 'repo', agent: 'ana', job: 'j1' })
    const done = Object.fromEntries(withJob.steps.filter((step) => step.done).map((step) => [step.key, step.done]))
    assert.deepStrictEqual(done, { 'knowledge:fila': 'catalog', 'spec:guia': 'approved', 'skill:akm-revisar': 'catalog' })
    assert.strictEqual(withJob.estimate.conversations, 11)
    assert.strictEqual(withJob.estimate.done, 3)
    const spent = withJob.steps.filter((step) => !step.done).reduce((sum, step) => sum + step.tokens.sources + step.tokens.protocol, 0)
    assert.strictEqual(withJob.estimate.inputTokens, spent)
    // A ordem não muda: o feito fica no lugar, para quem o cita.
    assert.deepStrictEqual(
      withJob.steps.map((step) => step.key),
      plan.steps.map((step) => step.key),
    )
  })

  it('o trabalho tem de ser deste projeto e do mesmo repositório', () => {
    const usecaseWithJobs = new ImportPlanUseCase({ scan, jobStates: (_projectId, jobId) => (jobId === 'outro-repo' ? { repository: 'x', states: new Map() } : undefined) })
    for (const job of ['nao-existe', 'outro-repo'])
      assert.throws(
        () => usecaseWithJobs.execute('alfa', { repository: 'repo', agent: 'ana', job }),
        (error: unknown) => error instanceof ImportPlanError && error.field === 'job',
      )
  })

  it('agente que não existe no inventário e prefixo inválido são recusados no campo', () => {
    assert.throws(
      () => usecase.execute('alfa', { repository: 'repo', agent: 'spec:base' }),
      (error: unknown) => error instanceof ImportPlanError && error.field === 'agent',
    )
    assert.throws(
      () => usecase.execute('alfa', { repository: 'repo', agent: 'ana', prefix: '../x' }),
      (error: unknown) => error instanceof ImportPlanError && error.field === 'prefix',
    )
  })
})
