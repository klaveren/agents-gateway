import assert from 'node:assert'
import { describe, it } from 'node:test'
import { capabilityRuns, capability, resolveCapabilities, toCapabilities } from './Capability.Catalog'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

const all = ['cap:terminal', 'cap:files.read', 'cap:files.write', 'cap:web.search', 'cap:web.fetch', 'cap:todos', 'mcp:gateway/list_agents']
const resolve = (protocol: EProvider, mode = EMode.AGENT, official = true) => resolveCapabilities(all, { protocol, mode, official })

describe('Capability.Catalog', () => {
  it('Claude, modo Agente: Terminal é o run_bash; arquivos e web, as nativas; o resto passa como veio', () => {
    const { allowedTools, unavailable } = resolve(EProvider.CLAUDE)
    assert.deepStrictEqual(allowedTools, [
      'run_bash',
      'sdk:Read',
      'sdk:Glob',
      'sdk:Grep',
      'sdk:Write',
      'sdk:Edit',
      'sdk:WebSearch',
      'sdk:WebFetch',
      'update_todos',
      'mcp:gateway/list_agents',
    ])
    assert.deepStrictEqual(unavailable, [])
    // ⛔ O Bash nativo nunca: Terminal é sempre o do gateway.
    assert.ok(!allowedTools.includes('sdk:Bash'))
    // O Claude por assinatura é da mesma família.
    assert.deepStrictEqual(resolve(EProvider.CLAUDE_SUB).allowedTools, allowedTools)
  })

  it('por token (OpenAI): arquivos do gateway; a busca é a hospedada só no oficial, senão a do gateway; Abrir página não roda', () => {
    const official = resolve(EProvider.OPENAI)
    assert.deepStrictEqual(official.allowedTools, [
      'run_bash',
      'read_file',
      'list_files',
      'search_files',
      'write_file',
      'edit_file',
      'sdk:openai:web_search',
      'update_todos',
      'mcp:gateway/list_agents',
    ])
    assert.deepStrictEqual(official.unavailable, ['Abrir página'])
    assert.ok(resolve(EProvider.OPENAI, EMode.AGENT, false).allowedTools.includes('search_web'))
  })

  it('modo Conversa: só as do gateway, mesmo no Claude', () => {
    const { allowedTools } = resolve(EProvider.CLAUDE, EMode.CHAT)
    assert.ok(allowedTools.includes('read_file') && allowedTools.includes('search_web'))
    assert.ok(!allowedTools.some((tool) => tool.startsWith('sdk:')))
  })

  it('assinaturas por CLI: o Codex usa o terminal dele; o Gemini, o que já traz; tarefas indisponíveis', () => {
    const codex = resolve(EProvider.CODEX)
    assert.deepStrictEqual(codex.allowedTools, ['sdk:codex:shell', 'sdk:codex:web_search', 'mcp:gateway/list_agents'])
    assert.deepStrictEqual(codex.unavailable, ['Abrir página', 'Lista de tarefas'])
    assert.deepStrictEqual(resolve(EProvider.ANTIGRAVITY).allowedTools, ['mcp:gateway/list_agents'])
  })

  it('a tela diz como roda; os ids antigos viram capacidade sem repetir', () => {
    assert.strictEqual(capabilityRuns(capability('cap:files.read')!, EProvider.CLAUDE_SUB), 'nativa do Claude')
    assert.strictEqual(capabilityRuns(capability('cap:files.read')!, EProvider.GOOGLE), 'do gateway')
    assert.strictEqual(capabilityRuns(capability('cap:web.fetch')!, EProvider.OPENAI), 'indisponível')
    assert.deepStrictEqual(toCapabilities(['sdk:Bash', 'run_bash', 'sdk:Read', 'sdk:Grep', 'sdk:openai:code_interpreter', 'update_todos']), [
      'cap:terminal',
      'cap:files.read',
      'sdk:openai:code_interpreter',
      'cap:todos',
    ])
  })
})
