import assert from 'node:assert'
import { describe, it } from 'node:test'
import { capabilityRuns, capability, hasWatch, resolveCapabilities, toCapabilities } from './Capability.Catalog'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { WAKE_ME_TOOL, WATCH_LIST_TOOL, WATCH_START_TOOL, WATCH_STOP_TOOL, WATCH_TOOLS } from './models/Watch.Model'

const all = ['cap:terminal', 'cap:files.read', 'cap:files.write', 'cap:web.search', 'cap:web.fetch', 'cap:todos', 'mcp:gateway/list_agents']
const resolve = (protocol: EProvider, mode = EMode.AGENT, official = true) => resolveCapabilities(all, { protocol, mode, official })

describe('Capability.Catalog', () => {
  it('Claude, modo Agente: Terminal é o run_bash; arquivos e web, as nativas; o resto passa como veio', () => {
    const { allowedTools, unavailable } = resolve(EProvider.CLAUDE)
    assert.deepStrictEqual(allowedTools, [
      'run_bash',
      'bash_start',
      'bash_logs',
      'bash_stop',
      'bash_list',
      'sdk:Read',
      'list_files',
      'search_files',
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

  it('por token (OpenAI): arquivos do gateway; a busca é a hospedada só no oficial, senão a do gateway; Abrir página é a do gateway', () => {
    const official = resolve(EProvider.OPENAI)
    assert.deepStrictEqual(official.allowedTools, [
      'run_bash',
      'bash_start',
      'bash_logs',
      'bash_stop',
      'bash_list',
      'read_file',
      'list_files',
      'search_files',
      'write_file',
      'edit_file',
      'sdk:openai:web_search',
      'fetch_url',
      'update_todos',
      'mcp:gateway/list_agents',
    ])
    assert.deepStrictEqual(official.unavailable, [])
    assert.ok(resolve(EProvider.OPENAI, EMode.AGENT, false).allowedTools.includes('search_web'))
  })

  it('modo Conversa: só as do gateway, mesmo no Claude', () => {
    const { allowedTools } = resolve(EProvider.CLAUDE, EMode.CHAT)
    assert.ok(allowedTools.includes('read_file') && allowedTools.includes('search_web'))
    assert.ok(!allowedTools.some((tool) => tool.startsWith('sdk:')))
  })

  it('assinaturas por CLI: o Codex e o Gemini com o terminal, os arquivos e as tarefas do gateway (por MCP)', () => {
    const codex = resolve(EProvider.CODEX)
    assert.deepStrictEqual(codex.allowedTools, [
      'run_bash',
      'bash_start',
      'bash_logs',
      'bash_stop',
      'bash_list',
      'read_file',
      'list_files',
      'search_files',
      'write_file',
      'edit_file',
      'sdk:codex:web_search',
      'fetch_url',
      'update_todos',
      'mcp:gateway/list_agents',
    ])
    assert.deepStrictEqual(codex.unavailable, [])
    // ⛔ O terminal do próprio Codex nunca sai da resolução, nem escolhido direto.
    assert.ok(!resolveCapabilities(['sdk:codex:shell'], { protocol: EProvider.CODEX, official: true, mode: EMode.AGENT }).allowedTools.length)
    // O Gemini também: o `--sandbox` dele nega o próprio terminal, e o projeto chega só pelas ferramentas do gateway.
    const gemini = resolve(EProvider.ANTIGRAVITY)
    assert.deepStrictEqual(gemini.allowedTools, [
      'run_bash',
      'bash_start',
      'bash_logs',
      'bash_stop',
      'bash_list',
      'read_file',
      'list_files',
      'search_files',
      'write_file',
      'edit_file',
      'update_todos',
      'mcp:gateway/list_agents',
    ])
    assert.deepStrictEqual(gemini.unavailable, ['Busca na web', 'Abrir página'])
  })

  it('a tela diz como roda; os ids antigos viram capacidade sem repetir', () => {
    assert.strictEqual(capabilityRuns(capability('cap:files.read')!, EProvider.CLAUDE_SUB), 'Read do Claude, busca do gateway')
    assert.strictEqual(capabilityRuns(capability('cap:files.read')!, EProvider.GOOGLE), 'do gateway')
    assert.strictEqual(capabilityRuns(capability('cap:web.fetch')!, EProvider.OPENAI), 'do gateway')
    assert.deepStrictEqual(toCapabilities(['sdk:Bash', 'run_bash', 'sdk:Read', 'sdk:Grep', 'sdk:openai:code_interpreter', 'update_todos']), [
      'cap:terminal',
      'cap:files.read',
      'sdk:openai:code_interpreter',
      'cap:todos',
    ])
  })
  it('Vigias: as quatro do gateway em todo provedor; ⛔ sem o terminal, a vigia por comando some e sobra o despertador', () => {
    for (const protocol of [EProvider.CLAUDE, EProvider.OPENAI, EProvider.CODEX]) {
      const withTerminal = resolveCapabilities(['cap:terminal', 'cap:watch'], { protocol, mode: EMode.AGENT, official: true })
      assert.deepStrictEqual(
        withTerminal.allowedTools.filter((tool) => WATCH_TOOLS.includes(tool)),
        [...WATCH_TOOLS],
      )
      assert.deepStrictEqual(withTerminal.unavailable, [])
      const alone = resolveCapabilities(['cap:watch'], { protocol, mode: EMode.AGENT, official: true })
      assert.deepStrictEqual(alone.allowedTools, [WAKE_ME_TOOL, WATCH_LIST_TOOL, WATCH_STOP_TOOL])
    }
    assert.ok(!resolveCapabilities(['cap:watch', WATCH_START_TOOL], { protocol: EProvider.OPENAI, mode: EMode.AGENT, official: true }).allowedTools.includes(WATCH_START_TOOL))
  })

  it('hasWatch: pela capacidade ou por uma das ferramentas', () => {
    assert.ok(hasWatch(['cap:todos', 'cap:watch']))
    assert.ok(hasWatch([WAKE_ME_TOOL]))
    assert.ok(!hasWatch(['cap:todos', 'run_bash']))
    assert.strictEqual(capability('cap:watch')?.label, 'Vigias')
  })
})
