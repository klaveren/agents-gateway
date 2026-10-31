import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { PROTOCOL_KINDS } from './models/Protocol.Model'
import {
  builderAgent,
  builderAgentId,
  builderKindOf,
  CORE_AGENT_IDS,
  IMPORT_TOOLS,
  importBuilderAgent,
  importBuilderAgentId,
  isImportBuilder,
  PROPOSE_DRAFT_TOOL,
} from './Builder.Agents'

describe('Builder.Agents', () => {
  it('um construtor por tipo, só de admin, só na lane agent, com o protocolo do core no prompt', () => {
    const agent = builderAgent('command', { provider: 'claude', models: ['claude-sonnet-5'] })
    assert.deepStrictEqual([agent.id, agent.adminOnly, agent.modes], ['builder-command', true, [EMode.AGENT]])
    assert.deepStrictEqual(agent.providers, [{ provider: 'claude', models: ['claude-sonnet-5'] }])
    assert.ok(agent.allowedTools.includes(PROPOSE_DRAFT_TOOL))
    assert.match(agent.systemPrompt, /# Protocolo de construção de command[\s\S]*\$ARGUMENTS/)
  })

  it('⛔ cada um com a leitura e a gravação do SEU tipo, e o prompt manda gravar só depois da confirmação', () => {
    const target = { provider: 'claude', models: ['m'] }
    assert.deepStrictEqual(builderAgent('rule', target).allowedTools, ['mcp:gateway/list_rules', 'mcp:gateway/save_rule', PROPOSE_DRAFT_TOOL, 'cap:todos'])
    assert.deepStrictEqual(builderAgent('adr', target).allowedTools, ['mcp:gateway/list_docs', 'mcp:gateway/get_doc', 'mcp:gateway/save_doc', PROPOSE_DRAFT_TOOL, 'cap:todos'])
    assert.deepStrictEqual(builderAgent('skill', target).allowedTools, ['mcp:gateway/list_resources', 'mcp:gateway/save_resource', PROPOSE_DRAFT_TOOL, 'cap:todos'])
    const spec = builderAgent('spec', target).systemPrompt
    assert.match(spec, /Só grave com save_doc DEPOIS que a pessoa disser nesta conversa \(ou o agente que delegou trouxer a confirmação dela\)/)
    assert.match(spec, /A pessoa confirmou: grave o último rascunho/)
    assert.match(spec, /# Protocolo de construção de spec/)
  })

  it('o de conhecimento pesquisa na web e lê a fonte, e começa pesquisando em vez de perguntar', () => {
    const knowledge = builderAgent('knowledge', { provider: 'claude', models: ['m'] })
    for (const tool of ['cap:web.search', 'cap:web.fetch', 'mcp:gateway/save_doc', PROPOSE_DRAFT_TOOL]) assert.ok(knowledge.allowedTools.includes(tool), tool)
    assert.match(knowledge.systemPrompt, /1\. Classifique o pedido \(é conhecimento\?\) e PESQUISE sem perguntar/)
    assert.match(knowledge.systemPrompt, /# Protocolo de construção de conhecimento[\s\S]*## Fontes/)
  })

  it('o de agentes consulta o catálogo e grava o agente, o contexto inicial e os recursos', () => {
    const builder = builderAgent('agent', { provider: 'claude', models: ['m'] })
    for (const tool of ['list_providers', 'list_models', 'list_tools', 'save_agent', 'set_agent_initial_context', 'set_agent_resources'])
      assert.ok(builder.allowedTools.includes(`mcp:gateway/${tool}`), tool)
    assert.match(builder.systemPrompt, /# Protocolo de construção de agente[\s\S]*## O checklist de nascimento/)
  })

  it('os ids reservados e o caminho de volta, do id ao tipo', () => {
    assert.deepStrictEqual(CORE_AGENT_IDS.slice(0, 7), ['builder-skill', 'builder-command', 'builder-rule', 'builder-spec', 'builder-adr', 'builder-knowledge', 'builder-agent'])
    assert.ok(CORE_AGENT_IDS.includes('builder-import-spec'))
    assert.deepStrictEqual([builderKindOf(builderAgentId('skill')), builderKindOf('atlas'), builderKindOf(undefined)], ['skill', undefined, undefined])
    assert.deepStrictEqual([builderKindOf(importBuilderAgentId('agent')), isImportBuilder('builder-import-agent'), isImportBuilder('builder-agent')], ['agent', true, false])
  })

  it('⛔ o modo importação: sem NENHUMA ferramenta de gravar, só a leitura do tipo e as três da importação', () => {
    const target = { provider: 'claude', models: ['m'] }
    for (const kind of PROTOCOL_KINDS) {
      const agent = importBuilderAgent(kind, target)
      assert.strictEqual(agent.id, `builder-import-${kind}`)
      assert.strictEqual(agent.adminOnly, true)
      assert.ok(!agent.allowedTools.some((tool) => /save_|set_agent_/.test(tool)), kind)
      assert.ok(!agent.allowedTools.includes(PROPOSE_DRAFT_TOOL), kind)
      for (const tool of IMPORT_TOOLS) assert.ok(agent.allowedTools.includes(tool), `${kind}: ${tool}`)
      // As permissões liberam só a leitura, uma a uma (nada de `gateway/*`).
      assert.ok(
        agent.permissions!.every((rule) => rule.decision === 'allow' && !rule.pattern.includes('*') && !/save_|set_/.test(rule.pattern)),
        kind,
      )
      assert.match(agent.systemPrompt, /o texto não muda[\s\S]*propose_import_draft[\s\S]*## Modo importação/)
    }
    assert.deepStrictEqual(importBuilderAgent('rule', target).allowedTools, ['mcp:gateway/list_rules', ...IMPORT_TOOLS, 'cap:todos'])
  })
})
