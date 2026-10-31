import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  agentDocument,
  docDocument,
  ICatalogDocument,
  mcpDocument,
  projectDocument,
  projectPermissionsDocument,
  resourceDocument,
  ruleDocument,
  TCanonicalBody,
} from '@domain/Catalog.Document'
import { withBody } from '@domain/Catalog.Import'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { CatalogReader } from './Catalog.Reader'
import { CatalogExportUseCase } from './CatalogExport.Usecase'
import { CatalogImportPlanner, parsePackage } from './CatalogImport.Plan'

const at = new Date('2026-10-30T12:00:00.000Z')

const agent = (patch: Partial<IAgent> & { id: string }): IAgent => ({
  name: patch.id,
  providers: [{ provider: 'claude', models: ['opus'] }],
  systemPrompt: `Prompt de ${patch.id}`,
  modes: [EMode.AGENT],
  allowedTools: [],
  ...patch,
})

/** Um gateway com um projeto, docs, recursos, rule, complemento, MCP, agentes e permissões — e o cofre de mentira. */
function build() {
  const repos = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const { agents, guidance, permissions, mcps, projects } = repos
  projects.insert({ id: 'alfa', name: 'Alfa', description: 'Projeto alfa', createdAt: at, updatedAt: at })
  guidance.insertDoc({ id: 'spec-g', kind: 'spec', title: 'Spec global', summary: 'S', body: 'B', createdAt: at, updatedAt: at })
  guidance.insertDoc({ id: 'spec-a', kind: 'spec', projectId: 'alfa', title: 'Spec alfa', summary: 'S', body: 'B', createdAt: at, updatedAt: at })
  guidance.insertDoc({ id: 'adr-a', kind: 'adr', projectId: 'alfa', title: 'ADR alfa', summary: 'S', body: 'B', createdAt: at, updatedAt: at })
  guidance.saveResource({ id: 'skill-a', kind: 'skill', projectId: 'alfa', description: 'D', body: 'B', docIds: ['spec-a'], createdAt: at, updatedAt: at })
  guidance.saveResource({ id: 'cmd-g', kind: 'command', description: 'D', body: '$ARGUMENTS', docIds: [], createdAt: at, updatedAt: at })
  guidance.insertRule({ id: 'rule-a', projectId: 'alfa', position: 1, title: 'Regra', body: 'B', enabled: true, createdAt: at, updatedAt: at })
  guidance.setProtocolAddendum('skill', 'alfa', { kind: 'skill', projectId: 'alfa', body: 'Mais', updatedAt: at })
  guidance.setContextDocs('alfa', ['spec-a'], 'ana')
  mcps.insert({ id: 'busca', name: 'Busca', url: 'https://mcp.example.com/', transport: 'auto', auth: 'none', enabled: true, projectId: 'alfa', createdAt: at, updatedAt: at })
  agents.save(agent({ id: 'theo', projectId: 'alfa', allowedTools: ['mcp:busca/*'] }), 'ana')
  agents.save(agent({ id: 'lia' }), 'ana')
  permissions.saveProjectRules('alfa', [{ category: 'terminal', pattern: 'git status', decision: 'allow' }], 'ana')

  const reader = new CatalogReader(repos)
  /** O cofre: `alfa.busca` tem o header cadastrado; o resto, nada. */
  const configured = new Set(['alfa.busca:header'])
  const planner = new CatalogImportPlanner({
    reader,
    agentRules: async () => ({ knownTools: ['run_bash'], agentExists: (id) => !!agents.list().find((item) => item.id === id) }),
    mcpSecrets: {
      secretStatus: (key) => ({ configured: configured.has(`${key}:header`) }) as never,
      envStatus: (key) => (mcps.get(key)?.container?.env ?? mcps.get(key)?.process?.env ?? []).map((name) => ({ name, configured: configured.has(`${key}:${name}`) })),
    },
  })
  const exporter = new CatalogExportUseCase({ reader, mask: { scan: (value) => ({ text: value, hits: [] }) }, now: () => at })
  return { ...repos, reader, planner, exporter, configured }
}

const byRef = (plan: { items: Array<{ ref: string }> }, ref: string) => {
  const item = plan.items.find((entry) => entry.ref === ref)
  assert.ok(item, `sem o item ${ref}`)
  return item as never as import('@domain/Catalog.Import').IImportPlanItem
}

const edit = (document: ICatalogDocument, patch: TCanonicalBody) => withBody(document, { ...document.body, ...patch })

describe('CatalogImportPlanner (dry-run)', () => {
  it('ida e volta: o pacote do export volta todo como unchanged, sem ampliação, sem ordem', async () => {
    const { exporter, planner } = build()
    const pack = exporter.run({ kind: 'all' })
    const plan = await planner.planPackage(pack)
    assert.strictEqual(plan.scope, 'all')
    assert.deepStrictEqual(plan.fileErrors, [])
    assert.ok(plan.items.length >= 10)
    assert.deepStrictEqual(
      plan.items.filter((item) => item.op !== 'unchanged').map((item) => [item.ref, item.op, item.issues]),
      [],
    )
    assert.deepStrictEqual(plan.order, [])
    assert.deepStrictEqual(plan.widenings, [])
    assert.strictEqual(plan.summary.unchanged, plan.items.length)

    // O escopo do manifesto vale quando o pedido não diz outro.
    const project = await planner.planPackage(exporter.run({ kind: 'project', projectId: 'alfa' }))
    assert.strictEqual(project.scope, 'project:alfa')
    assert.ok(project.items.every((item) => item.op === 'unchanged'))
  })

  it('NÍVEL 2 direto: o documento canônico (do importador) sem passar por arquivo', async () => {
    const { planner, reader } = build()
    const plan = await planner.planDocuments(reader.list({ kind: 'all' }), { kind: 'all' })
    assert.ok(plan.items.every((item) => item.op === 'unchanged'))
  })

  it('create e update com diff contra o atual; nada é gravado', async () => {
    const { planner, reader } = build()
    const before = JSON.stringify(reader.list({ kind: 'all' }))
    const spec = reader.read('spec', 'spec-a')!
    const plan = await planner.planDocuments(
      [
        edit(spec, { body: 'B\nmais uma linha' }),
        docDocument({ id: 'kn-novo', kind: 'knowledge', projectId: 'alfa', title: 'Novo', summary: 'S', body: 'Conhecimento', createdAt: at, updatedAt: at }),
      ],
      { kind: 'project', projectId: 'alfa' },
    )
    const update = byRef(plan, 'spec/spec-a')
    assert.strictEqual(update.op, 'update')
    assert.strictEqual(update.currentHash, spec.hash)
    assert.ok(update.diff && !update.diff.equal && update.diff.added >= 1)
    assert.match(update.diff.unified, /\+.*mais uma linha/)
    const create = byRef(plan, 'knowledge/kn-novo')
    assert.strictEqual(create.op, 'create')
    assert.strictEqual(create.currentHash, undefined)
    assert.ok(create.diff!.added > 0 && create.diff!.removed === 0)
    assert.deepStrictEqual([plan.summary.create, plan.summary.update], [1, 1])
    // ⛔ Dry-run: o catálogo é o mesmo depois.
    assert.strictEqual(JSON.stringify(reader.list({ kind: 'all' })), before)
  })

  it('item inválido vira error com o motivo do domínio; campo fora da forma também', async () => {
    const { planner, reader } = build()
    const rule = reader.read('rule', 'rule-a')!
    const theo = reader.read('agent', 'theo')!
    const plan = await planner.planDocuments(
      [
        edit(rule, { title: '' }),
        edit(theo, { modes: [] }),
        withBody({ kind: 'spec', id: 'spec-g' }, { ...reader.read('spec', 'spec-g')!.body, apiKey: 'x' }),
        withBody({ kind: 'command', id: 'X' }, { id: 'X', description: 'D', body: 'B', docIds: [] }),
      ],
      { kind: 'all' },
    )
    assert.strictEqual(byRef(plan, 'rule/rule-a').op, 'error')
    assert.deepStrictEqual(byRef(plan, 'rule/rule-a').issues, [{ field: 'title', message: 'required' }])
    assert.ok(byRef(plan, 'agent/theo').issues.some((issue) => issue.field === 'modes'))
    assert.deepStrictEqual(byRef(plan, 'spec/spec-g').issues, [{ field: 'apiKey', message: 'not a field of the catalog document' }])
    assert.ok(byRef(plan, 'command/X').issues.some((issue) => issue.field === 'id'))
    assert.deepStrictEqual(plan.order, [])
    assert.strictEqual(plan.summary.error, 4)
  })

  it('referência quebrada: doc, recurso, contexto inicial, mcp: e agent: que não existem nem no catálogo nem no pacote', async () => {
    const { planner } = build()
    const plan = await planner.planDocuments(
      [
        resourceDocument({ id: 'skill-b', kind: 'skill', projectId: 'alfa', description: 'D', body: 'B', docIds: ['doc-sumido'], createdAt: at, updatedAt: at }),
        agentDocument(agent({ id: 'nina', projectId: 'alfa', allowedTools: ['mcp:fantasma/*', 'agent:ninguem'] }), {
          resources: { skills: ['skill-nenhuma'], commands: ['*'] },
          initialContext: ['spec-nenhuma'],
        }),
        // Citações resolvidas DENTRO do pacote não quebram.
        agentDocument(agent({ id: 'rui', projectId: 'alfa', allowedTools: ['agent:nina'] }), { resources: { skills: ['skill-a'], commands: [] }, initialContext: ['spec-a'] }),
      ],
      { kind: 'all' },
    )
    const broken = plan.brokenRefs.map((ref) => `${ref.from} ${ref.field} ${ref.target}:${ref.id} ${ref.reason}`).sort()
    assert.deepStrictEqual(broken, [
      'agent/nina allowedTools agent:ninguem missing',
      'agent/nina allowedTools mcp:fantasma missing',
      'agent/nina initialContext spec:spec-nenhuma missing',
      'agent/nina resources.skills skill:skill-nenhuma missing',
      'agent/rui allowedTools agent:nina package-error',
      'skill/skill-b docIds doc:doc-sumido missing',
    ])
    assert.strictEqual(byRef(plan, 'agent/nina').op, 'error')
    assert.strictEqual(byRef(plan, 'skill/skill-b').op, 'error')
    // Quem depende de um item do pacote que não se aplica também não se aplica (com o motivo).
    const rui = byRef(plan, 'agent/rui')
    assert.strictEqual(rui.op, 'error')
    assert.deepStrictEqual(
      rui.brokenRefs.map((ref) => ref.reason),
      ['package-error'],
    )
  })

  it('ampliação calculada: agente, permissão de projeto e MCP; token marca que não se aplica', async () => {
    const { planner, reader } = build()
    const theo = reader.read('agent', 'theo')!
    const perms = reader.read('project-permissions', 'alfa')!
    const documents = [
      edit(theo, { allowedTools: ['agent:lia', 'mcp:busca/*'] }),
      edit(perms, { rules: [{ category: 'terminal', decision: 'allow', pattern: 'git *' }] }),
      mcpDocument({ id: 'novo', name: 'Novo', url: 'https://novo.example.com/', transport: 'auto', auth: 'none', enabled: true, projectId: 'alfa', createdAt: at, updatedAt: at }),
    ]
    const plan = await planner.planDocuments(documents, { kind: 'project', projectId: 'alfa' })
    assert.deepStrictEqual(
      plan.widenings.map((item) => item.key),
      ['mcp/novo@alfa#new~remote:https://novo.example.com/', 'agent/theo@alfa#allowedTools+agent:lia', 'project-permissions/alfa#rules+allow:terminal:git *'],
    )
    assert.deepStrictEqual(plan.caller, { viaAccessToken: false, wideningsApplicable: true })
    assert.ok(plan.items.every((item) => !item.blockedByToken))

    const token = await planner.planDocuments(documents, { kind: 'project', projectId: 'alfa' }, { viaAccessToken: true })
    assert.deepStrictEqual(token.caller, { viaAccessToken: true, wideningsApplicable: false })
    assert.deepStrictEqual(
      token.items.filter((item) => item.blockedByToken).map((item) => item.ref),
      ['mcp/alfa.novo', 'agent/theo', 'project-permissions/alfa'],
    )
    // O plano é o mesmo (o hash não depende de quem pede).
    assert.strictEqual(token.planHash, plan.planHash)
  })

  it('MCP com segredo faltando: listado, e o ligado entra desligado', async () => {
    const { planner, reader, configured } = build()
    const busca = reader.read('mcp', 'busca', 'alfa')!
    const header = edit(busca, { auth: 'header', headerName: 'Authorization' })
    const novo = mcpDocument({
      id: 'banco',
      name: 'Banco',
      kind: 'container',
      container: { image: 'acme/banco:1', args: [], writable: [], memoryMb: 256, cpus: 1, network: 'none', allowedHosts: [], env: ['DB_PASSWORD'] },
      url: '',
      transport: 'auto',
      auth: 'none',
      enabled: true,
      projectId: 'alfa',
      createdAt: at,
      updatedAt: at,
    })
    const plan = await planner.planDocuments([header, novo], { kind: 'all' })
    assert.deepStrictEqual(byRef(plan, 'mcp/alfa.busca').missingSecrets, undefined)
    const banco = byRef(plan, 'mcp/alfa.banco')
    assert.deepStrictEqual(banco.missingSecrets, ['env:DB_PASSWORD'])
    assert.strictEqual(banco.entersDisabled, true)
    assert.match(banco.diff!.unified, /"enabled": false/)
    assert.deepStrictEqual(plan.missingSecrets, [{ ref: 'mcp/alfa.banco', id: 'banco', projectId: 'alfa', secrets: ['env:DB_PASSWORD'] }])

    const withSecret = await planner.planDocuments([header], { kind: 'all' })
    configured.delete('alfa.busca:header')
    const missing = await planner.planDocuments([header], { kind: 'all' })
    assert.deepStrictEqual(byRef(missing, 'mcp/alfa.busca').missingSecrets, ['header'])
    // O cofre também é estado usado: muda o hash.
    assert.notStrictEqual(missing.planHash, withSecret.planHash)
  })

  it('ordem: projeto → docs → recursos → … → agentes → permissões; citado antes de quem cita; restringe antes de ampliar', async () => {
    const { planner, reader } = build()
    const lia = reader.read('agent', 'lia')!
    const plan = await planner.planDocuments(
      [
        projectPermissionsDocument('beta', [{ category: 'terminal', pattern: 'ls', decision: 'allow' }]),
        agentDocument(agent({ id: 'ze', projectId: 'beta', allowedTools: ['agent:bia'] }), { resources: { skills: ['skill-b'], commands: [] }, initialContext: [] }),
        agentDocument(agent({ id: 'bia', projectId: 'beta' }), { resources: { skills: [], commands: [] }, initialContext: [] }),
        // Restringe (perde a lane, sem ganhar nada): vem antes dos agentes que ampliam.
        edit(lia, { systemPrompt: 'Outro prompt' }),
        resourceDocument({ id: 'skill-b', kind: 'skill', projectId: 'beta', description: 'D', body: 'B', docIds: ['spec-b2', 'spec-b1'], createdAt: at, updatedAt: at }),
        docDocument({ id: 'spec-b1', kind: 'spec', projectId: 'beta', title: 'B1', summary: '', body: 'B', docIds: ['spec-b2'], createdAt: at, updatedAt: at }),
        docDocument({ id: 'spec-b2', kind: 'spec', projectId: 'beta', title: 'B2', summary: '', body: 'B', createdAt: at, updatedAt: at }),
        projectDocument({ id: 'beta', name: 'Beta', createdAt: at, updatedAt: at }, ['spec-b1']),
        ruleDocument({ id: 'rule-b', projectId: 'beta', position: 1, title: 'R', body: 'B', enabled: true, createdAt: at, updatedAt: at }),
      ],
      { kind: 'all' },
    )
    assert.deepStrictEqual(
      plan.items.filter((item) => item.op === 'error').map((item) => [item.ref, item.issues]),
      [],
    )
    assert.deepStrictEqual(
      plan.order.map((step) => `${step.phase}:${step.ref}${step.part ? `(${step.part})` : ''}`),
      [
        'project:project/beta(record)',
        'docs:spec/spec-b2',
        'docs:spec/spec-b1',
        'resources:skill/skill-b',
        'rules:rule/rule-b',
        'agents:agent/lia',
        'agents:agent/bia',
        // O agente que ganha ferramenta entra fechado; o alcance vem depois dos vínculos (fase reach).
        'agents:agent/ze(record)',
        'links:project/beta(links)',
        'reach:agent/ze(reach)',
        'permissions:project-permissions/beta',
      ],
    )
    assert.ok(!plan.order.find((step) => step.ref === 'agent/lia')!.widens)
    assert.ok(!plan.order.find((step) => step.ref === 'agent/ze' && step.part === 'record')!.widens)
    assert.ok(plan.order.find((step) => step.ref === 'agent/ze' && step.part === 'reach')!.widens)
  })

  it('planHash: estável (ordem de entrada não importa) e muda quando o estado atual usado muda', async () => {
    const { planner, reader, guidance } = build()
    const spec = edit(reader.read('spec', 'spec-a')!, { body: 'Novo corpo' })
    const skill = resourceDocument({ id: 'skill-c', kind: 'skill', description: 'D', body: 'B', docIds: ['spec-g'], createdAt: at, updatedAt: at })
    const one = await planner.planDocuments([spec, skill], { kind: 'all' })
    const two = await planner.planDocuments([skill, spec], { kind: 'all' })
    assert.match(one.planHash, /^[a-f0-9]{64}$/)
    assert.strictEqual(one.planHash, two.planHash)

    // O item tocado mudou no catálogo.
    guidance.updateDoc('spec-a', { body: 'Mexido', updatedAt: at })
    const touched = await planner.planDocuments([spec, skill], { kind: 'all' })
    assert.notStrictEqual(touched.planHash, one.planHash)
    // O item CITADO mudou (o doc que a skill anexa), mesmo sem o plano tocá-lo.
    guidance.updateDoc('spec-g', { body: 'Outro', updatedAt: at })
    const cited = await planner.planDocuments([spec, skill], { kind: 'all' })
    assert.notStrictEqual(cited.planHash, touched.planHash)
    // E o pacote mudou.
    const other = await planner.planDocuments([edit(spec, { body: 'Outro corpo' }), skill], { kind: 'all' })
    assert.notStrictEqual(other.planHash, cited.planHash)
  })

  it('escopo e conflito: fora do escopo é erro; id de outro tipo ou de fora do escopo é conflito; campo mascarado também', async () => {
    const { planner, reader } = build()
    const plan = await planner.planDocuments(
      [
        docDocument({ id: 'spec-x', kind: 'spec', title: 'Global', summary: '', body: 'B', createdAt: at, updatedAt: at }),
        docDocument({ id: 'adr-a', kind: 'spec', projectId: 'alfa', title: 'Era ADR', summary: '', body: 'B', createdAt: at, updatedAt: at }),
        edit(reader.read('skill', 'skill-a')!, { body: 'token [segredo:token do GitHub]' }),
      ],
      { kind: 'project', projectId: 'alfa' },
    )
    assert.strictEqual(byRef(plan, 'spec/spec-x').op, 'error')
    assert.strictEqual(byRef(plan, 'spec/adr-a').op, 'conflict')
    assert.strictEqual(byRef(plan, 'skill/skill-a').op, 'conflict')

    const outside = await planner.planDocuments([agentDocument(agent({ id: 'lia', projectId: 'alfa' }), { resources: { skills: [], commands: [] }, initialContext: [] })], {
      kind: 'project',
      projectId: 'alfa',
    })
    assert.strictEqual(byRef(outside, 'agent/lia').op, 'conflict')
    assert.match(byRef(outside, 'agent/lia').issues[0].message, /outside the plan scope \(global\)/)
  })

  it('parsePackage: erro por arquivo, e o manifesto de formato desconhecido', () => {
    const parsed = parsePackage({ 'catalog.json': JSON.stringify({ format: 9, scope: 'all', masked: [] }), 'global/coisas/x.md': 'oi' })
    assert.deepStrictEqual(parsed.errors.map((error) => error.path).sort(), ['catalog.json', 'global/coisas/x.md'])
    assert.deepStrictEqual(parsed.documents, [])
    assert.strictEqual(parsed.manifest?.scope, 'all')
  })
})
