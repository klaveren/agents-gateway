import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { TCatalogKind } from '@domain/Catalog.Document'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { AgentCatalog, ISaveAgentOptions } from './Agent.Catalog'
import { CatalogHistoryService } from './CatalogHistory.Service'
import { CatalogReader } from './Catalog.Reader'
import { GuidanceService } from './Guidance.Service'
import { McpServersService } from './McpServers.Service'
import { PermissionsService } from './Permissions.Service'
import { ProjectsService } from './Projects.Service'

const at = new Date('2026-10-30T12:00:00.000Z')

const agent = (id: string, projectId?: string): IAgent => ({
  id,
  name: id.toUpperCase(),
  providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
  systemPrompt: `Prompt de ${id}`,
  modes: [EMode.CHAT],
  allowedTools: ['search_web'],
  ...(projectId ? { projectId } : {}),
})

const saving = (by: string, creating: boolean): ISaveAgentOptions => ({ rules: { knownTools: ['search_web'], providerOf: () => EProvider.GOOGLE }, by, creating })

/** Os serviços de escrita de verdade, cada um com o seu repositório em memória, e o histórico ligado a todos. */
function build() {
  const repos = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const history = new SqliteCatalogHistoryRepository(':memory:')
  const service = new CatalogHistoryService(history, new CatalogReader(repos), () => at)
  const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')

  const agents = new AgentCatalog(repos.agents)
  const guidance = new GuidanceService(
    repos.guidance,
    (projectId) => !!repos.projects.get(projectId),
    (agentId) => {
      const found = agents.rawEntries().find((entry) => entry.agent.id === agentId)?.agent
      return found ? { id: found.id, ...(found.projectId ? { projectId: found.projectId } : {}) } : undefined
    },
  )
  const permissions = new PermissionsService(repos.permissions, () => undefined)
  const mcps = new McpServersService(
    repos.mcps,
    secrets,
    () => agents.rawEntries().map((entry) => entry.agent),
    (projectId) => !!repos.projects.get(projectId),
  )
  const projects = new ProjectsService(
    repos.projects,
    () => agents.rawEntries().map((entry) => entry.agent),
    () => true,
    {
      create: (id) => `/tmp/${id}`,
      remove: (id) => {
        guidance.removeProject(id)
        permissions.removeProject(id)
        mcps.removeProject(id)
      },
    },
  )
  for (const writer of [agents, guidance, permissions, mcps, projects]) writer.history.use(() => service)

  const revisions = (kind: TCatalogKind, id: string) => history.revisions(kind, id)
  const ops = (kind: TCatalogKind, id: string) => revisions(kind, id).map((revision) => `${revision.op}:${revision.by}`)
  return { repos, history, service, secrets, agents, guidance, permissions, mcps, projects, revisions, ops }
}

describe('CatalogHistoryService — a gravação nos serviços', () => {
  it('agente: create, update e delete, cada um com o autor; gravar igual não cria revisão', () => {
    const { agents, revisions, ops } = build()
    agents.save(agent('pesquisa'), saving('ana', true))
    agents.save(agent('pesquisa'), saving('bia', false))
    agents.save({ ...agent('pesquisa'), name: 'Pesquisa 2' }, saving('bia', false))
    agents.remove('pesquisa', 'caio')

    assert.deepStrictEqual(ops('agent', 'pesquisa'), ['create:ana', 'update:bia', 'delete:caio'])
    const [created, updated, deleted] = revisions('agent', 'pesquisa')
    assert.deepStrictEqual([created.revision, updated.revision, deleted.revision], [1, 2, 3])
    assert.match(updated.document!, /"name": "Pesquisa 2"/)
    assert.strictEqual(updated.source, 'api')
    assert.strictEqual(deleted.document, undefined)
    assert.strictEqual(deleted.hash, undefined)
  })

  it('agente: os vínculos (recursos e contexto) entram no documento dele; o trigger vem da ferramenta e a mudança de projeto da migração', () => {
    const { agents, guidance, projects, revisions, ops } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    agents.save(agent('pesquisa'), saving('ana', true))
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'faça tabelas' }, 'ana')
    guidance.setAgentResources('pesquisa', { skills: ['tabela'], commands: [] }, 'bia')
    guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'ana')
    guidance.setAgentContext('pesquisa', ['guia'], 'caio')
    agents.saveTriggers('pesquisa', [{ id: 'ao-abrir', when: 'ao abrir', body: 'olá' }], 'agent:atlas')
    agents.moveToProject('pesquisa', 'alfa', 'migração')

    assert.deepStrictEqual(ops('agent', 'pesquisa'), ['create:ana', 'update:bia', 'update:caio', 'update:agent:atlas', 'update:migração'])
    const list = revisions('agent', 'pesquisa')
    assert.match(list[1].document!, /"skills": \[\n\s+"tabela"/)
    assert.match(list[2].document!, /"initialContext": \[\n\s+"guia"/)
    assert.deepStrictEqual(
      list.map((revision) => revision.source),
      ['api', 'api', 'api', 'agent', 'migration'],
    )
    assert.strictEqual(list[4].projectId, 'alfa')
  })

  it('skill e command: create, update e delete com o autor', () => {
    const { guidance, ops } = build()
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'faça' }, 'ana')
    guidance.updateResource('tabela', { body: 'faça melhor' }, 'bia')
    guidance.deleteResource('tabela', 'caio')
    guidance.createResource({ id: 'resumo', kind: 'command', description: 'Resumo', body: '$ARGUMENTS' }, 'ana')
    guidance.updateResource('resumo', { description: 'Resumir' }, 'bia')
    guidance.deleteResource('resumo', 'caio')

    assert.deepStrictEqual(ops('skill', 'tabela'), ['create:ana', 'update:bia', 'delete:caio'])
    assert.deepStrictEqual(ops('command', 'resumo'), ['create:ana', 'update:bia', 'delete:caio'])
  })

  it('rule: create, update, mover e apagar — a renumeração grava as vizinhas, com o mesmo autor', () => {
    const { guidance, ops, revisions } = build()
    const a = guidance.createRule({ title: 'A', body: 'a' }, 'ana')
    const b = guidance.createRule({ title: 'B', body: 'b' }, 'ana')
    const c = guidance.createRule({ title: 'C', body: 'c' }, 'ana')
    guidance.updateRule(a.id, { body: 'a2' }, 'bia')
    guidance.moveRule(c.id, 'up', 'caio')
    guidance.deleteRule(a.id, 'dani')

    assert.deepStrictEqual(ops('rule', a.id), ['create:ana', 'update:bia', 'delete:dani'])
    // C subiu (troca com B) e depois, sem A, virou a 1.
    assert.deepStrictEqual(ops('rule', c.id), ['create:ana', 'update:caio', 'update:dani'])
    assert.deepStrictEqual(ops('rule', b.id), ['create:ana', 'update:caio', 'update:dani'])
    assert.match(revisions('rule', c.id).at(-1)!.document!, /"position": 1/)
  })

  it('spec, ADR e knowledge: create, update e delete; trocar o tipo sai de uma chave e entra na outra', () => {
    const { guidance, ops } = build()
    guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'ana')
    guidance.updateDoc('guia', { body: 'B2' }, 'bia')
    guidance.updateDoc('guia', { kind: 'adr' }, 'caio')
    guidance.deleteDoc('guia', 'dani')
    guidance.createDoc({ id: 'saber', kind: 'knowledge', title: 'Saber', summary: 'S', body: 'B' }, 'ana')

    assert.deepStrictEqual(ops('spec', 'guia'), ['create:ana', 'update:bia', 'delete:caio'])
    assert.deepStrictEqual(ops('adr', 'guia'), ['create:caio', 'delete:dani'])
    assert.deepStrictEqual(ops('knowledge', 'saber'), ['create:ana'])
  })

  it('complemento de protocolo: gravar, mudar e apagar (corpo vazio), global e de projeto', () => {
    const { guidance, projects, ops, revisions } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    guidance.setProtocolAddendum('skill', null, 'Mais isto', 'ana')
    guidance.setProtocolAddendum('skill', null, 'Mais aquilo', 'bia')
    guidance.setProtocolAddendum('skill', null, '', 'caio')
    guidance.setProtocolAddendum('skill', 'alfa', 'Do projeto', 'ana')

    assert.deepStrictEqual(ops('protocol', 'skill'), ['create:ana', 'update:bia', 'delete:caio'])
    assert.deepStrictEqual(ops('protocol', 'alfa/skill'), ['create:ana'])
    assert.strictEqual(revisions('protocol', 'alfa/skill')[0].projectId, 'alfa')
  })

  it('projeto e permissões do projeto: create, update; o contexto inicial entra no projeto', () => {
    const { guidance, projects, permissions, ops, revisions } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    projects.update('alfa', { description: 'O primeiro' }, 'bia')
    guidance.createDoc({ id: 'guia', kind: 'spec', projectId: 'alfa', title: 'Guia', summary: 'S', body: 'B' }, 'ana')
    guidance.setInitialContext('alfa', ['guia'], 'caio')
    permissions.saveProjectRules('alfa', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }], 'dani')

    assert.deepStrictEqual(ops('project', 'alfa'), ['create:ana', 'update:bia', 'update:caio'])
    assert.deepStrictEqual(ops('project-permissions', 'alfa'), ['create:ana', 'update:dani'])
    assert.match(revisions('project-permissions', 'alfa')[1].document!, /"pattern": "git \*"/)
  })

  it('MCP: create, update e delete pela chave com o escopo; o mesmo id em dois projetos são itens diferentes', () => {
    const { mcps, projects, ops, revisions } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'root')
    projects.create({ id: 'beta', name: 'Beta' }, 'root')
    mcps.create({ id: 'crm', projectId: 'alfa', name: 'CRM A', url: 'https://a.exemplo.com/mcp' }, 'ana')
    mcps.create({ id: 'crm', projectId: 'beta', name: 'CRM B', url: 'https://b.exemplo.com/mcp' }, 'bia')
    mcps.update('alfa.crm', { name: 'CRM A2' }, 'caio')
    mcps.remove('beta.crm', 'dani')

    assert.deepStrictEqual(ops('mcp', 'alfa.crm'), ['create:ana', 'update:caio'])
    assert.deepStrictEqual(ops('mcp', 'beta.crm'), ['create:bia', 'delete:dani'])
    assert.deepStrictEqual(ops('mcp', 'crm'), [])
    assert.deepStrictEqual(
      revisions('mcp', 'beta.crm').map((revision) => revision.projectId),
      ['beta', 'beta'],
    )
  })

  it('MCP: trocar o escopo apaga a chave antiga e cria a nova', () => {
    const { mcps, projects, ops } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'root')
    mcps.create({ id: 'crm', name: 'CRM', url: 'https://a.exemplo.com/mcp' }, 'ana')
    mcps.update('crm', { projectId: 'alfa' }, 'bia')

    assert.deepStrictEqual(ops('mcp', 'crm'), ['create:ana', 'delete:bia'])
    assert.deepStrictEqual(ops('mcp', 'alfa.crm'), ['create:bia'])
  })

  it('⛔ MCP: nenhum segredo no documento da revisão — nem o header, nem as variáveis; só os nomes', () => {
    const { mcps, revisions, secrets } = build()
    const header = 'Bearer s3gr3d0-do-header'
    mcps.create({ id: 'crm', name: 'CRM', url: 'https://a.exemplo.com/mcp', auth: 'header', headerName: 'Authorization', secret: header }, 'ana')
    mcps.create({ id: 'pw', name: 'Playwright', kind: 'container', container: { image: 'mcr.microsoft.com/playwright', env: ['API_TOKEN'] } }, 'ana')
    mcps.saveEnv('pw', 'API_TOKEN', 'tok-valor-secreto', 'ana')
    mcps.saveSecret('crm', 'Bearer outro-segredo', 'bia')

    assert.strictEqual(secrets.get('mcp:crm'), 'Bearer outro-segredo')
    const all = [...revisions('mcp', 'crm'), ...revisions('mcp', 'pw')]
    // Trocar o segredo não muda o documento: não há revisão nova.
    assert.strictEqual(all.length, 2)
    for (const revision of all) {
      for (const secret of [header, 'Bearer outro-segredo', 'tok-valor-secreto', 's3gr3d0']) assert.ok(!revision.document!.includes(secret), `vazou ${secret}`)
    }
    assert.match(revisions('mcp', 'crm')[0].document!, /"header"/)
    assert.match(revisions('mcp', 'pw')[0].document!, /"env:API_TOKEN"/)
  })
})

describe('CatalogHistoryService — a cascata', () => {
  it('apagar um doc grava as skills, os docs, os agentes e os projetos que o citavam, com o mesmo autor', () => {
    const { agents, guidance, projects, ops, revisions } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'root')
    agents.save(agent('pesquisa'), saving('root', true))
    guidance.createDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'B' }, 'root')
    guidance.createDoc({ id: 'pai', kind: 'knowledge', title: 'Pai', summary: 'S', body: 'B', docIds: ['guia'] }, 'root')
    guidance.createDoc({ id: 'solto', kind: 'spec', title: 'Solto', summary: 'S', body: 'B' }, 'root')
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'T', body: 'B', docIds: ['guia'] }, 'root')
    guidance.createResource({ id: 'outra', kind: 'skill', description: 'O', body: 'B' }, 'root')
    guidance.setAgentContext('pesquisa', ['guia'], 'root')
    guidance.setInitialContext('alfa', ['guia'], 'root')

    guidance.deleteDoc('guia', 'dani')

    assert.deepStrictEqual(ops('spec', 'guia').at(-1), 'delete:dani')
    assert.deepStrictEqual(ops('skill', 'tabela').at(-1), 'update:dani')
    assert.deepStrictEqual(ops('knowledge', 'pai').at(-1), 'update:dani')
    assert.deepStrictEqual(ops('agent', 'pesquisa').at(-1), 'update:dani')
    assert.deepStrictEqual(ops('project', 'alfa').at(-1), 'update:dani')
    // Quem não citava fica como estava.
    assert.deepStrictEqual(ops('skill', 'outra'), ['create:root'])
    assert.deepStrictEqual(ops('spec', 'solto'), ['create:root'])
    assert.doesNotMatch(revisions('skill', 'tabela').at(-1)!.document!, /guia/)
  })

  it('apagar uma skill grava os agentes que a liberavam (e o que tinha todas fica como estava)', () => {
    const { agents, guidance, ops, revisions } = build()
    agents.save(agent('pesquisa'), saving('root', true))
    agents.save(agent('todos'), saving('root', true))
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'T', body: 'B' }, 'root')
    guidance.setAgentResources('pesquisa', { skills: ['tabela'], commands: [] }, 'root')

    guidance.deleteResource('tabela', 'dani')

    assert.deepStrictEqual(ops('agent', 'pesquisa').at(-1), 'update:dani')
    assert.match(revisions('agent', 'pesquisa').at(-1)!.document!, /"skills": \[\]/)
    assert.deepStrictEqual(ops('agent', 'todos'), ['create:root'])
  })

  it('apagar o projeto grava o delete de tudo o que ia junto — rules, docs, recursos, complementos, permissões e MCPs', () => {
    const { guidance, projects, permissions, mcps, ops } = build()
    projects.create({ id: 'alfa', name: 'Alfa' }, 'root')
    const rule = guidance.createRule({ projectId: 'alfa', title: 'R', body: 'B' }, 'root')
    guidance.createDoc({ id: 'guia', kind: 'spec', projectId: 'alfa', title: 'Guia', summary: 'S', body: 'B' }, 'root')
    guidance.createResource({ id: 'tabela', kind: 'skill', projectId: 'alfa', description: 'T', body: 'B' }, 'root')
    guidance.setProtocolAddendum('skill', 'alfa', 'Mais', 'root')
    permissions.saveProjectRules('alfa', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }], 'root')
    mcps.create({ id: 'crm', projectId: 'alfa', name: 'CRM', url: 'https://a.exemplo.com/mcp' }, 'root')
    guidance.createRule({ title: 'Global', body: 'B' }, 'root')

    projects.remove('alfa', 'dani')

    for (const [kind, id] of [
      ['project', 'alfa'],
      ['project-permissions', 'alfa'],
      ['rule', rule.id],
      ['spec', 'guia'],
      ['skill', 'tabela'],
      ['protocol', 'alfa/skill'],
      ['mcp', 'alfa.crm'],
    ] as const)
      assert.strictEqual(ops(kind, id).at(-1), 'delete:dani', `${kind}/${id}`)
  })
})

describe('CatalogHistoryService — a reconciliação do boot', () => {
  it('item sem revisão ganha a baseline (autor system); rodar de novo não grava nada', () => {
    const { repos, service, revisions } = build()
    repos.agents.seedOnce([agent('atlas')], 'seed')
    repos.projects.insert({ id: 'alfa', name: 'Alfa', createdAt: at, updatedAt: at })
    repos.mcps.seedOnce([
      { id: 'gateway', name: 'Gateway', kind: 'remote', url: 'http://localhost:3000/mcp', transport: 'http', auth: 'caller', enabled: true, createdAt: at, updatedAt: at },
    ])

    assert.deepStrictEqual(service.reconcile(), { baseline: 4, drift: 0 })
    const [first] = revisions('agent', 'atlas')
    assert.deepStrictEqual([first.op, first.by, first.source, first.revision], ['baseline', 'system', 'boot', 1])
    assert.strictEqual(revisions('project-permissions', 'alfa')[0].op, 'baseline')
    assert.strictEqual(revisions('mcp', 'gateway')[0].op, 'baseline')
    assert.deepStrictEqual(service.reconcile(), { baseline: 0, drift: 0 })
  })

  it('deriva: o que mudou, sumiu ou voltou fora do histórico ganha revisão `drift`, autor system', () => {
    const { repos, service, agents, guidance, revisions } = build()
    agents.save(agent('pesquisa'), saving('ana', true))
    guidance.createRule({ title: 'R', body: 'B' }, 'ana')
    guidance.createResource({ id: 'tabela', kind: 'skill', description: 'T', body: 'B' }, 'ana')

    // A migração mexe direto no repositório; a rule some e a skill some e volta, tudo sem passar pelo serviço.
    repos.agents.migrateOnce('teste', 'pesquisa', (stored) => ({ ...stored, name: 'Migrado' }), 'seed')
    const [rule] = repos.guidance.rules(null)
    repos.guidance.deleteRule(rule.id)
    guidance.deleteResource('tabela', 'ana')
    repos.guidance.saveResource({ id: 'tabela', kind: 'skill', description: 'T', body: 'B', docIds: [], createdAt: at, updatedAt: at })

    assert.deepStrictEqual(service.reconcile(), { baseline: 0, drift: 3 })
    const drift = revisions('agent', 'pesquisa').at(-1)!
    assert.deepStrictEqual([drift.op, drift.by, drift.source, drift.revision], ['drift', 'system', 'boot', 2])
    assert.match(drift.document!, /"name": "Migrado"/)
    const gone = revisions('rule', rule.id).at(-1)!
    assert.deepStrictEqual([gone.op, gone.document], ['drift', undefined])
    assert.deepStrictEqual(
      revisions('skill', 'tabela').map((revision) => revision.op),
      ['create', 'delete', 'drift'],
    )
    assert.deepStrictEqual(service.reconcile(), { baseline: 0, drift: 0 })
  })

  it('deriva: a edição direta no banco também é achada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-history-'))
    const path = join(dir, 'gateway.db')
    const guidance = new SqliteGuidanceRepository(path)
    const reader = new CatalogReader({
      agents: new SqliteAgentRepository(':memory:'),
      guidance,
      permissions: new SqlitePermissionRepository(':memory:'),
      mcps: new SqliteMcpServerRepository(':memory:'),
      projects: new SqliteProjectRepository(':memory:'),
    })
    const history = new SqliteCatalogHistoryRepository(path)
    const service = new CatalogHistoryService(history, reader, () => at)
    guidance.insertDoc({ id: 'guia', kind: 'spec', title: 'Guia', summary: 'S', body: 'antes', docIds: [], createdAt: at, updatedAt: at })
    assert.deepStrictEqual(service.reconcile(), { baseline: 1, drift: 0 })

    new DatabaseSync(path).prepare("UPDATE project_docs SET body = 'depois' WHERE id = 'guia'").run()

    assert.deepStrictEqual(service.reconcile(), { baseline: 0, drift: 1 })
    assert.match(history.revisions('spec', 'guia').at(-1)!.document!, /"body": "depois"/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a janela de falha: a escrita não cai se o histórico falhar, e o boot grava a deriva depois', () => {
    const { agents, service, revisions } = build()
    agents.history.use(() => {
      throw new Error('banco do histórico fora do ar')
    })
    const warn = console.warn
    console.warn = () => undefined
    try {
      agents.save(agent('pesquisa'), saving('ana', true))
    } finally {
      console.warn = warn
    }
    assert.ok(agents.get('pesquisa'))
    assert.deepStrictEqual(revisions('agent', 'pesquisa'), [])
    assert.deepStrictEqual(service.reconcile(), { baseline: 1, drift: 0 })
  })
})
