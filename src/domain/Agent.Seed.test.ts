import { describe, it } from 'node:test'
import assert from 'node:assert'
import { agentIssues } from './Agent.Policy'
import { AGENT_MIGRATIONS } from './Agent.Migrations'
import { AGENT_SEED, BUILDER_DELEGATIONS } from './Agent.Seed'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

describe('AGENT_SEED', () => {
  it('o Atlas dos usuários e o Atlas Admin', () => {
    assert.deepStrictEqual(
      AGENT_SEED.map((agent) => agent.id),
      ['atlas', 'atlas-admin'],
    )
  })

  it('⚖️ o sistema operacional só no Atlas Admin, que só o admin abre; o Atlas fica no MCP do gateway', () => {
    const [atlas, admin] = AGENT_SEED

    assert.ok(!atlas.adminOnly)
    assert.ok(atlas.allowedTools.every((tool) => tool.startsWith('mcp:gateway/') || tool.startsWith('agent:builder-') || tool === 'sdk:WebSearch'))
    assert.strictEqual(admin.adminOnly, true)
    for (const tool of ['sdk:Bash', 'sdk:Read', 'sdk:Write', 'sdk:Edit']) assert.ok(admin.allowedTools.includes(tool), tool)
    assert.ok(atlas.allowedTools.every((tool) => admin.allowedTools.includes(tool)))
  })

  it('o Atlas Admin instala o que falta pela guia Pacotes; o Atlas dos usuários não', () => {
    const [atlas, admin] = AGENT_SEED
    const packages = ['list_packages', 'search_packages', 'install_package', 'remove_package'].map((tool) => `mcp:gateway/${tool}`)
    for (const tool of packages) assert.ok(admin.allowedTools.includes(tool), tool)
    assert.ok(packages.every((tool) => !atlas.allowedTools.includes(tool)))
    assert.match(admin.systemPrompt, /search_packages/)
  })

  it('o Atlas é um agente Claude da lane agent, com raciocínio e a WebSearch nativa', () => {
    const [atlas] = AGENT_SEED

    assert.strictEqual(atlas.providers[0].provider, EProvider.CLAUDE)
    assert.deepStrictEqual(atlas.modes, [EMode.AGENT])
    assert.ok(atlas.providers[0].models.includes('claude-sonnet-5'))
    assert.ok(atlas.reasoningEfforts?.includes('high'))
    assert.ok(atlas.allowedTools.includes('sdk:WebSearch'))
  })

  it('⛔ o Atlas só delega aos construtores do core — sem send_message / start_conversation — e não grava conteúdo', () => {
    for (const agent of AGENT_SEED) {
      assert.deepStrictEqual(
        agent.allowedTools.filter((tool) => tool.startsWith('agent:')),
        ['agent:builder-skill', 'agent:builder-command', 'agent:builder-rule', 'agent:builder-spec', 'agent:builder-adr', 'agent:builder-knowledge'],
      )
      assert.ok(
        agent.allowedTools.every((tool) => !/send_message|start_conversation|save_rule|save_doc|save_resource/.test(tool)),
        agent.id,
      )
      assert.match(agent.systemPrompt, /## Construtores[\s\S]*Nunca confirme por conta própria/)
    }
  })

  it('os dois passam pela regra de agente (as tools do próprio gateway vêm do servidor MCP `gateway`)', () => {
    for (const agent of AGENT_SEED) {
      const issues = agentIssues(agent, {
        takenIds: [],
        knownTools: [],
        providerOf: (model) => (model.startsWith('claude') ? EProvider.CLAUDE : undefined),
        mcpServerExists: (server) => server === 'gateway',
        agentExists: (id) => id.startsWith('builder-'),
      })

      assert.deepStrictEqual(issues, [], agent.id)
    }
  })

  it('a migração tira do Atlas que já existe o gravar conteúdo, dá a delegação e acrescenta a seção — uma vez só', () => {
    const repository = new NullAgentRepository()
    const old = { ...AGENT_SEED[0], systemPrompt: 'prompt antigo', allowedTools: ['sdk:WebSearch', 'mcp:gateway/save_doc', 'mcp:gateway/list_docs', 'mcp:gateway/save_rule'] }
    repository.save(old, 'seed')
    const [migration] = AGENT_MIGRATIONS
    repository.migrateOnce(migration.key, 'atlas', migration.change, 'seed')

    const atlas = repository.list()[0]
    assert.deepStrictEqual(atlas.allowedTools, ['sdk:WebSearch', 'mcp:gateway/list_docs', ...BUILDER_DELEGATIONS])
    assert.match(atlas.systemPrompt, /^prompt antigo\n\n## Construtores/)

    // Quem administra mexeu depois: a migração não roda de novo.
    repository.save({ ...atlas, allowedTools: ['sdk:WebSearch', 'mcp:gateway/save_doc'] }, 'admin')
    repository.migrateOnce(migration.key, 'atlas', migration.change, 'seed')
    assert.deepStrictEqual(repository.list()[0].allowedTools, ['sdk:WebSearch', 'mcp:gateway/save_doc'])
    // O agente apagado fica apagado.
    repository.migrateOnce(migration.key, 'atlas-admin', migration.change, 'seed')
    assert.strictEqual(repository.list().length, 1)
  })

  it('a migração do conhecimento ensina o Atlas que já tinha os construtores a delegar o estudo — uma vez', () => {
    const repository = new NullAgentRepository()
    repository.save({ ...AGENT_SEED[0], systemPrompt: 'prompt\n\n## Construtores (sem conhecimento)' }, 'seed')
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-knowledge')!
    repository.migrateOnce(migration.key, 'atlas', migration.change, 'seed')
    assert.match(repository.list()[0].systemPrompt, /Construtores \(sem conhecimento\)\nPesquisa ou estudo de um tema[\s\S]*builder-knowledge/)
    // O Atlas novo já nasce com a linha: a migração não a repete.
    assert.strictEqual(migration.change(AGENT_SEED[0]), undefined)
  })
})
