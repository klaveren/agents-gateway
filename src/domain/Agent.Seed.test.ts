import { UPDATE_TODOS_TOOL } from './models/ConversationTodo.Model'
import { WATCH_TOOLS } from './models/Watch.Model'
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { agentIssues } from './Agent.Policy'
import { AGENT_MIGRATIONS, applyAgentMigrations, atlasTriggersPrompt, withoutAtlasTalkLine } from './Agent.Migrations'
import {
  AGENT_SEED,
  ATLAS_ADMIN_LITE_PROMPT,
  ATLAS_ADMIN_PROMPT,
  ATLAS_AGENTS,
  ATLAS_ALL_GATEWAY_TOOLS,
  ATLAS_HOOKS_SECTION,
  ATLAS_IMPORT_LINE,
  ATLAS_PRICES_SECTION,
  ATLAS_TRIGGERS,
  BUILDER_DELEGATIONS,
  LEGACY_ATLAS_ADMIN_LITE_PROMPT,
  LEGACY_ATLAS_ADMIN_PROMPT,
  LEGACY_ATLAS_TALK_LINE,
} from './Agent.Seed'
import { triggerIssues } from './Agent.Policy'
import { IAgent } from './models/Agent.Model'
import { IAgentRepository } from './ports/AgentRepository.Port'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

/** O que o boot faz (ver `makeAgents`): a semente e, depois, cada migração nos agentes dela. */
function boot(repository: IAgentRepository): void {
  repository.seedOnce(AGENT_SEED, 'seed')
  applyAgentMigrations(repository)
}

const TRIGGER_IDS = ['migrate-environment', 'update-model-prices', 'create-hook', 'create-schedule', 'install-missing-tool']

/** O Atlas Admin de uma instalação de antes: a lista de ferramentas nome a nome, sem trigger, o prompt com as seções. */
function legacyAdmin(systemPrompt = LEGACY_ATLAS_ADMIN_PROMPT): IAgent {
  const { triggers: _triggers, ...admin } = ATLAS_AGENTS[1]
  return {
    ...admin,
    systemPrompt,
    allowedTools: ['cap:web.search', 'cap:terminal', 'mcp:gateway/list_agents', 'mcp:gateway/import_items', 'mcp:outro/algo', ...BUILDER_DELEGATIONS],
  }
}

describe('AGENT_SEED', () => {
  it('a instalação nova nasce só com o Atlas Admin: o Assistente e o Atlas dos usuários saíram da semente', () => {
    assert.deepStrictEqual(
      AGENT_SEED.map((agent) => agent.id),
      ['atlas-admin'],
    )
  })

  it('a família Atlas: o dos usuários (aposentado da semente, ainda nas instalações de antes) e o Atlas Admin', () => {
    assert.deepStrictEqual(
      ATLAS_AGENTS.map((agent) => agent.id),
      ['atlas', 'atlas-admin'],
    )
  })

  it('⚖️ o sistema operacional só no Atlas Admin, que só o admin abre; o Atlas fica no MCP do gateway', () => {
    const [atlas, admin] = ATLAS_AGENTS

    assert.ok(!atlas.adminOnly)
    assert.ok(atlas.allowedTools.every((tool) => tool.startsWith('mcp:gateway/') || tool.startsWith('agent:builder-') || tool.startsWith('cap:')))
    assert.ok(!atlas.allowedTools.some((tool) => ['cap:terminal', 'cap:files.read', 'cap:files.write'].includes(tool)))
    assert.strictEqual(admin.adminOnly, true)
    for (const tool of ['cap:terminal', 'cap:files.read', 'cap:files.write']) assert.ok(admin.allowedTools.includes(tool), tool)
  })

  it('o Atlas Admin nasce com TODAS as ferramentas do gateway (o curinga), sem lista nome a nome; o dos usuários não', () => {
    const [atlas, admin] = ATLAS_AGENTS
    assert.strictEqual(ATLAS_ALL_GATEWAY_TOOLS, 'mcp:gateway/*')
    assert.deepStrictEqual(
      admin.allowedTools.filter((tool) => tool.startsWith('mcp:')),
      ['mcp:gateway/*'],
    )
    assert.ok(!atlas.allowedTools.includes('mcp:gateway/*'))
  })

  it('o que o Atlas Admin sabe fazer são triggers: ids em inglês, um "quando" de uma linha, o procedimento no corpo', () => {
    const [atlas, admin] = ATLAS_AGENTS
    assert.deepStrictEqual(
      admin.triggers?.map((trigger) => trigger.id),
      TRIGGER_IDS,
    )
    assert.deepStrictEqual(triggerIssues(admin.triggers), [])
    assert.strictEqual(atlas.triggers, undefined)
    const body = (id: string): string => ATLAS_TRIGGERS.find((trigger) => trigger.id === id)!.body
    assert.match(body('update-model-prices'), /set_model_price/)
    assert.match(body('create-hook'), /save_hook/)
    assert.match(body('create-schedule'), /save_schedule/)
    assert.match(body('install-missing-tool'), /search_packages/)
    // O procedimento saiu do prompt: lá ficam só o gatilho da migração e onde instalar.
    for (const section of ['## Atualizar os preços', '## Hooks', '## Agendamentos', '## Migrar um ambiente', '## Instalar o que falta'])
      assert.ok(!admin.systemPrompt.includes(section), section)
    assert.ok(admin.systemPrompt.includes(ATLAS_IMPORT_LINE))
    assert.match(admin.systemPrompt, /pelo trigger install-missing-tool/)
  })

  it('migrar é orquestrar: mede com import_items, mostra o plano, delega um item por vez ao construtor e confere', () => {
    const { when, body } = ATLAS_TRIGGERS[0]
    assert.match(when, /migrar ou importar/)
    assert.match(body, /ORQUESTRA/)
    assert.match(body, /import_items[\s\S]*plano[\s\S]*delegate_to_agent[\s\S]*preview_system_prompt/)
    // O que é da pessoa: o segredo ele só pede, nunca recebe.
    assert.match(body, /request_secret/)
  })

  it('o Atlas nasce sem modelo (quem instala escolhe), na lane agent, com raciocínio e a busca na web', () => {
    const [atlas] = ATLAS_AGENTS

    assert.deepStrictEqual(atlas.providers, [])
    assert.deepStrictEqual(atlas.modes, [EMode.AGENT])
    assert.ok(atlas.reasoningEfforts?.includes('high'))
    assert.ok(atlas.allowedTools.includes('cap:web.search'))
  })

  it('⛔ o Atlas cria conteúdo por delegação aos construtores do core; o dos usuários nem tem como gravar ou conversar', () => {
    const [atlas, admin] = ATLAS_AGENTS
    for (const agent of ATLAS_AGENTS) {
      assert.deepStrictEqual(
        agent.allowedTools.filter((tool) => tool.startsWith('agent:')),
        ['agent:builder-skill', 'agent:builder-command', 'agent:builder-rule', 'agent:builder-spec', 'agent:builder-adr', 'agent:builder-knowledge', 'agent:builder-agent'],
      )
      assert.match(agent.systemPrompt, /## Agentes\nCriar ou ajustar um AGENTE é com o builder-agent/)
      assert.match(agent.systemPrompt, /## Construtores[\s\S]*Nunca confirme por conta própria/)
    }
    assert.ok(atlas.allowedTools.every((tool) => !/send_message|start_conversation|save_rule|save_doc|save_resource|save_agent/.test(tool)))
    // O Admin tem todas (o curinga): a regra é do prompt — gravar é do construtor.
    assert.match(admin.systemPrompt, /Você tem as ferramentas de gravar \(save_\*, patch_agent\), mas NÃO cria nem reescreve/)
    // Conversar com outro agente não é ferramenta de agente: o prompt não a cita.
    assert.ok(!/start_conversation|send_message/.test(admin.systemPrompt))
    assert.ok(admin.allowedTools.includes('cap:watch'))
    assert.ok(!admin.systemPrompt.includes('Você não tem mais o save_agent'))
  })

  it('a semente passa pela regra de agente, salvo o modelo (as tools do próprio gateway vêm do servidor MCP `gateway`)', () => {
    for (const agent of [...AGENT_SEED, ...ATLAS_AGENTS]) {
      const issues = agentIssues(agent, {
        takenIds: [],
        knownTools: [UPDATE_TODOS_TOOL, ...WATCH_TOOLS, 'search_web', 'fetch_url', 'run_bash', 'read_file', 'write_file'],
        providerOf: (model) => (model.startsWith('claude') ? EProvider.CLAUDE : undefined),
        mcpServerExists: (server) => server === 'gateway',
        agentExists: (id) => id.startsWith('builder-'),
      })

      // O único problema é o esperado: nasce sem modelo (quem instala escolhe).
      assert.deepStrictEqual(
        issues.map((issue) => issue.field),
        ['providers'],
        agent.id,
      )
    }
  })

  it('a migração tira do Atlas que já existe o gravar conteúdo, dá a delegação e acrescenta a seção — uma vez só', () => {
    const repository = new NullAgentRepository()
    const old = { ...ATLAS_AGENTS[0], systemPrompt: 'prompt antigo', allowedTools: ['sdk:WebSearch', 'mcp:gateway/save_doc', 'mcp:gateway/list_docs', 'mcp:gateway/save_rule'] }
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
    repository.save({ ...ATLAS_AGENTS[0], systemPrompt: 'prompt\n\n## Construtores (sem conhecimento)' }, 'seed')
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-knowledge')!
    repository.migrateOnce(migration.key, 'atlas', migration.change, 'seed')
    assert.match(repository.list()[0].systemPrompt, /Construtores \(sem conhecimento\)\nPesquisa ou estudo de um tema[\s\S]*builder-knowledge/)
    // O Atlas novo já nasce com a linha: a migração não a repete.
    assert.strictEqual(migration.change(ATLAS_AGENTS[0]), undefined)
  })

  it('a migração da migração: o Atlas que já existe aprende a migrar um ambiente (import_items, construtor, importedFrom) — uma vez', () => {
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-migration')!
    const changed = migration.change({ ...ATLAS_AGENTS[0], systemPrompt: 'antigo' })!
    assert.match(changed.systemPrompt, /^antigo\n\n## Migrar um ambiente para o gateway[\s\S]*import_items[\s\S]*importedFrom/)
    assert.strictEqual(migration.change(changed), undefined)
    // O Atlas novo já nasce com a seção e com a ferramenta.
    assert.strictEqual(migration.change(ATLAS_AGENTS[0]), undefined)
    assert.ok(ATLAS_AGENTS[0].allowedTools.includes('mcp:gateway/import_items'))
  })

  it('a migração do construtor de agentes tira o save_agent do Atlas que já existe e ensina a delegar — uma vez', () => {
    const repository = new NullAgentRepository()
    repository.save({ ...ATLAS_AGENTS[0], systemPrompt: 'antigo', allowedTools: ['mcp:gateway/save_agent', 'mcp:gateway/list_agents'] }, 'seed')
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-agent-builder')!
    repository.migrateOnce(migration.key, 'atlas', migration.change, 'seed')
    const atlas = repository.list()[0]
    assert.deepStrictEqual(atlas.allowedTools, ['mcp:gateway/list_agents'])
    assert.match(atlas.systemPrompt, /^antigo\n\n## Agentes\nCriar ou ajustar um AGENTE é com o builder-agent/)
    assert.strictEqual(migration.change(ATLAS_AGENTS[0]), undefined)
  })

  it('os CLIs rodam com o sandbox fixo: o nível e a rede escolhidos para o Codex e o Gemini saem; os de outro ficam', () => {
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'cli-fixed-sandbox')!
    const base = { id: 'cx', name: 'Cx', systemPrompt: 'p', modes: [EMode.AGENT], allowedTools: [] }
    const changed = migration.change({
      ...base,
      providers: [
        { provider: EProvider.CODEX, models: ['m'], sandbox: 'workspace-write', network: true },
        { provider: EProvider.ANTIGRAVITY, models: ['g'], sandbox: 'full' },
        { provider: EProvider.CLAUDE, models: ['c'] },
      ],
    })
    assert.deepStrictEqual(changed?.providers, [
      { provider: EProvider.CODEX, models: ['m'] },
      { provider: EProvider.ANTIGRAVITY, models: ['g'] },
      { provider: EProvider.CLAUDE, models: ['c'] },
    ])
    assert.strictEqual(migration.change({ ...base, providers: [{ provider: EProvider.CODEX, models: ['m'] }] }), undefined)
  })

  it('a lista de tarefas virou do gateway: quem tinha o TodoWrite nativo ganha o update_todos — uma vez', () => {
    const repository = new NullAgentRepository()
    repository.save({ ...ATLAS_AGENTS[0], id: 'qualquer', allowedTools: ['sdk:TodoWrite', 'sdk:WebSearch'] }, 'seed')
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'todos-native')!
    assert.strictEqual(migration.agentIds, '*')
    repository.migrateOnce(migration.key, 'qualquer', migration.change, 'seed')
    assert.deepStrictEqual(repository.list()[0].allowedTools, ['sdk:WebSearch', UPDATE_TODOS_TOOL])
    assert.strictEqual(migration.change({ ...ATLAS_AGENTS[0], allowedTools: ['sdk:WebSearch'] }), undefined)
  })

  it('as capacidades: os ids de antes viram cap:, o Bash nativo vira o Terminal do gateway — uma vez', () => {
    const repository = new NullAgentRepository()
    repository.save({ ...ATLAS_AGENTS[0], id: 'antigo', allowedTools: ['sdk:Bash', 'sdk:Read', 'sdk:Write', 'search_web', 'mcp:gateway/list_agents'] }, 'seed')
    const migration = AGENT_MIGRATIONS.find((item) => item.key === 'capabilities')!
    repository.migrateOnce(migration.key, 'antigo', migration.change, 'seed')
    assert.deepStrictEqual(repository.list()[0].allowedTools, ['cap:terminal', 'cap:files.read', 'cap:files.write', 'cap:web.search', 'mcp:gateway/list_agents'])
    assert.strictEqual(migration.change(repository.list()[0]), undefined)
  })
})

describe('atlas-triggers', () => {
  const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-triggers')!

  it('o banco novo: só o Atlas Admin, e nenhuma migração mexe no que a semente escreveu', () => {
    const repository = new NullAgentRepository()
    boot(repository)
    const [admin, ...others] = repository.list()
    assert.deepStrictEqual(others, [])
    assert.strictEqual(admin.id, 'atlas-admin')
    assert.strictEqual(admin.systemPrompt, ATLAS_ADMIN_PROMPT)
    assert.deepStrictEqual(admin.allowedTools, ATLAS_AGENTS[1].allowedTools)
    assert.deepStrictEqual(admin.triggers, ATLAS_TRIGGERS)
    assert.strictEqual(migration.change(ATLAS_AGENTS[1]), undefined)
  })

  it('o banco de antes, prompt da semente antiga: as seções viram triggers e o curinga toma o lugar da lista — uma vez', () => {
    const repository = new SqliteAgentRepository(':memory:')
    // A instalação de antes: semeada com a lista nome a nome e o Assistente.
    const assistant: IAgent = { ...legacyAdmin('converse'), id: 'assistente', name: 'Assistente', adminOnly: false, allowedTools: ['cap:web.search'] }
    repository.seedOnce([assistant, legacyAdmin()], 'seed')
    boot(repository)

    const admin = repository.list().find((agent) => agent.id === 'atlas-admin')!
    assert.strictEqual(admin.systemPrompt, ATLAS_ADMIN_PROMPT)
    assert.deepStrictEqual(
      admin.triggers?.map((trigger) => trigger.id),
      TRIGGER_IDS,
    )
    // O curinga chegou pela semente (`grantSeedTools`) e os nomes soltos do gateway saíram; o de outro MCP fica.
    assert.ok(admin.allowedTools.includes('mcp:outro/algo'))
    assert.deepStrictEqual(
      admin.allowedTools.filter((tool) => tool.startsWith('mcp:gateway/')),
      ['mcp:gateway/*'],
    )
    // Quem já tinha o Assistente continua com ele.
    assert.strictEqual(repository.list().find((agent) => agent.id === 'assistente')?.systemPrompt, 'converse')

    // Quem administra tirou um trigger depois: o boot seguinte não o devolve.
    const { createdAt: _created, updatedAt: _updated, updatedBy: _by, ...stored } = admin
    repository.save({ ...stored, triggers: stored.triggers?.filter((trigger) => trigger.id !== 'create-hook') }, 'admin')
    boot(repository)
    assert.strictEqual(repository.list().find((agent) => agent.id === 'atlas-admin')?.triggers?.length, 4)
  })

  it('o prompt que quem administra editou: a seção mexida fica, as iguais às da semente saem, a linha do importador entra', () => {
    const edited = ATLAS_HOOKS_SECTION.replace('## Hooks', '## Hooks (do meu jeito)')
    const changed = migration.change(legacyAdmin(`${LEGACY_ATLAS_ADMIN_PROMPT.replace(ATLAS_HOOKS_SECTION, edited)}\n\n## Minha seção\nfica`))!

    assert.ok(changed.systemPrompt.includes(edited))
    assert.ok(changed.systemPrompt.includes('## Minha seção\nfica'))
    assert.ok(!changed.systemPrompt.includes(ATLAS_PRICES_SECTION))
    for (const section of ['## Agendamentos', '## Migrar um ambiente', '## Instalar o que falta']) assert.ok(!changed.systemPrompt.includes(section), section)
    assert.ok(!/\n{3,}/.test(changed.systemPrompt))
    assert.ok(changed.systemPrompt.endsWith(`\n\n${ATLAS_IMPORT_LINE}`))
    assert.ok(!changed.systemPrompt.includes(LEGACY_ATLAS_TALK_LINE))
    assert.match(changed.systemPrompt, /pelo trigger install-missing-tool/)
    assert.match(changed.systemPrompt, /Você tem as ferramentas de gravar/)
    // Os triggers entram do mesmo jeito; o que o agente já tinha com o mesmo id não é sobrescrito.
    assert.deepStrictEqual(
      changed.triggers?.map((trigger) => trigger.id),
      TRIGGER_IDS,
    )
    const mine = { id: 'create-hook', when: 'meu quando', body: 'meu corpo' }
    const kept = migration.change({ ...legacyAdmin(), triggers: [mine] })!
    assert.deepStrictEqual(kept.triggers?.[0], mine)
    assert.strictEqual(kept.triggers?.length, 5)
    // Sem o curinga (tirado pela tela, ou sem banco), a lista de ferramentas fica como está.
    assert.deepStrictEqual(changed.allowedTools, legacyAdmin().allowedTools)
  })

  it('um prompt todo de quem administra só ganha a linha do importador; na lite, nada', () => {
    assert.strictEqual(atlasTriggersPrompt('meu prompt', 'pro'), `meu prompt\n\n${ATLAS_IMPORT_LINE}`)
    assert.strictEqual(atlasTriggersPrompt('meu prompt', 'lite'), 'meu prompt')
    assert.strictEqual(atlasTriggersPrompt(ATLAS_ADMIN_PROMPT, 'pro'), ATLAS_ADMIN_PROMPT)
    // A lite de antes (o prompt lite da semente antiga) vira a lite de agora: os preços são trigger.
    assert.strictEqual(atlasTriggersPrompt(LEGACY_ATLAS_ADMIN_LITE_PROMPT, 'lite'), ATLAS_ADMIN_LITE_PROMPT)
    assert.strictEqual(atlasTriggersPrompt(ATLAS_ADMIN_LITE_PROMPT, 'lite'), ATLAS_ADMIN_LITE_PROMPT)
  })

  it('as migrações de antes não devolvem a seção a quem já tem o trigger', () => {
    for (const key of ['atlas-schedules', 'atlas-migration']) {
      const old = AGENT_MIGRATIONS.find((item) => item.key === key)!
      assert.strictEqual(old.change(ATLAS_AGENTS[1]), undefined, key)
    }
  })
})

describe('atlas-talk-line', () => {
  const migration = AGENT_MIGRATIONS.find((item) => item.key === 'atlas-talk-line')!
  const admin = ATLAS_AGENTS[1]

  it('só o Atlas Admin; a linha sai de onde a semente de antes e a migração dos triggers a puseram', () => {
    assert.deepStrictEqual(migration.agentIds, ['atlas-admin'])
    // A semente de antes: logo depois da abertura (pro e lite).
    const [intro, ...rest] = ATLAS_ADMIN_PROMPT.split('\n\n')
    const seeded = [`${intro}\n${LEGACY_ATLAS_TALK_LINE}`, ...rest].join('\n\n')
    assert.strictEqual(migration.change({ ...admin, systemPrompt: seeded })?.systemPrompt, ATLAS_ADMIN_PROMPT)
    const [liteIntro, ...liteRest] = ATLAS_ADMIN_LITE_PROMPT.split('\n\n')
    // Na lite a linha vinha depois da última seção da base, antes da do sistema operacional.
    const lite = ATLAS_ADMIN_LITE_PROMPT.replace('\n\n## Sistema operacional', `\n${LEGACY_ATLAS_TALK_LINE}\n\n## Sistema operacional`)
    assert.notStrictEqual(lite, ATLAS_ADMIN_LITE_PROMPT)
    assert.strictEqual(migration.change({ ...admin, systemPrompt: lite })?.systemPrompt, ATLAS_ADMIN_LITE_PROMPT)
    assert.ok(liteIntro && liteRest.length)
    // A migração dos triggers: no fim do prompt de quem administra, sozinha (lite) ou antes da do importador.
    assert.strictEqual(withoutAtlasTalkLine(`meu prompt\n\n${LEGACY_ATLAS_TALK_LINE}\n${ATLAS_IMPORT_LINE}`), `meu prompt\n\n${ATLAS_IMPORT_LINE}`)
    assert.strictEqual(withoutAtlasTalkLine(`meu prompt\n\n${LEGACY_ATLAS_TALK_LINE}`), 'meu prompt')
  })

  it('quem reescreveu a linha, ou já não a tem, fica como está', () => {
    assert.strictEqual(migration.change(admin), undefined)
    const mine = `${ATLAS_ADMIN_PROMPT}\nConversar com outro agente (start_conversation) quando eu mandar.`
    assert.strictEqual(migration.change({ ...admin, systemPrompt: mine }), undefined)
  })
})

describe('watch-capability', () => {
  const migration = AGENT_MIGRATIONS.find((item) => item.key === 'watch-capability')!
  const base = { ...ATLAS_AGENTS[0], allowedTools: ['cap:terminal'] }

  it('todo agente que conversa com gente ganha as vigias; o subagente e quem já as tem, não', () => {
    assert.deepStrictEqual(migration.change({ ...base, id: 'maya' })?.allowedTools, ['cap:terminal', 'cap:watch'])
    assert.strictEqual(migration.change({ ...base, id: 'sub', role: 'subagent' }), undefined)
    assert.strictEqual(migration.change({ ...base, id: 'tem', allowedTools: ['cap:watch'] }), undefined)
    assert.strictEqual(migration.change({ ...base, id: 'avulsa', allowedTools: ['wake_me'] }), undefined)
  })

  for (const [name, make] of [
    ['em memória', () => new NullAgentRepository()],
    ['no SQLite', () => new SqliteAgentRepository(':memory:')],
  ] as const)
    it(`uma vez por banco (${name}): quem desligou depois e quem nasceu depois ficam como estão`, () => {
      const repository = make()
      repository.save({ ...base, id: 'maya' }, 'admin')
      repository.save({ ...base, id: 'sub', role: 'subagent' }, 'admin')
      boot(repository)
      const tools = (id: string) => repository.list().find((agent) => agent.id === id)?.allowedTools
      assert.deepStrictEqual(tools('maya'), ['cap:terminal', 'cap:watch'])
      assert.deepStrictEqual(tools('sub'), ['cap:terminal'])
      assert.ok(tools('atlas-admin')?.includes('cap:watch'))

      // Quem administra desligou na Maya e criou a Argos sem vigia: o boot seguinte não religa nenhuma das duas.
      repository.save({ ...base, id: 'maya' }, 'admin')
      repository.save({ ...base, id: 'argos' }, 'admin')
      boot(repository)
      assert.deepStrictEqual(tools('maya'), ['cap:terminal'])
      assert.deepStrictEqual(tools('argos'), ['cap:terminal'])
    })
})
