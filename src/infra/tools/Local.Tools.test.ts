import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeLocalTools, type IExecOptions, type TExec } from './Local.Tools'
import { ILocalTool } from './Tool.Types'
import { GuidanceService } from '@application/Guidance.Service'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'

describe('LocalTools', () => {
  const policy = { timeoutMs: 1234, maxOutputChars: 50, cwd: '/tmp/sandbox' }

  const noopExec: TExec = async () => ({ stdout: 'ok', stderr: '' })

  const toolsWith = (exec?: TExec, fetchHtml?: (query: string) => Promise<string>) => makeLocalTools({ exec: exec ?? noopExec, fetchHtml: fetchHtml ?? (async () => ''), policy })
  const find = (tools: ILocalTool[], name: string): ILocalTool => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `${name} missing`)
    return tool
  }

  it('exposes exactly the two built-in tools', () => {
    assert.deepStrictEqual(
      toolsWith().map((tool) => tool.name),
      ['search_web', 'run_bash'],
    )
  })

  it('runs a command inside the configured policy', async () => {
    let seen: IExecOptions | undefined
    const tools = toolsWith(async (_command: string, options: IExecOptions) => {
      seen = options
      return { stdout: 'a.txt\n', stderr: '' }
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'ls' })

    assert.strictEqual(outcome.status, 'success')
    assert.strictEqual(outcome.result, 'a.txt\n')
    assert.strictEqual(seen?.timeout, 1234)
    assert.strictEqual(seen?.cwd, '/tmp/sandbox')
  })

  it('⛔ o shell recebe o ambiente mínimo (sem chave, token ou segredo) e, sem BASH_CWD, a pasta vazia da conversa', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, gate: process.env.AUTH_SECRET }
    process.env.OPENAI_API_KEY = 'sk-nao-pode-vazar'
    process.env.AUTH_SECRET = 'segredo-nao-pode-vazar'
    try {
      let seen: IExecOptions | undefined
      const tools = makeLocalTools({
        exec: async (_command, options) => ((seen = options), { stdout: 'ok', stderr: '' }),
        fetchHtml: async () => '',
        policy: { ...policy, cwd: '' },
      })
      await find(tools, 'run_bash').execute({ command: 'env' }, { sessionId: 'conv-1' })

      assert.ok(seen?.env.PATH)
      assert.ok(!JSON.stringify(seen?.env).includes('nao-pode-vazar'))
      assert.match(seen?.cwd ?? '', /gateway-sub\/conv-1$/)
    } finally {
      for (const [name, value] of [
        ['OPENAI_API_KEY', saved.key],
        ['AUTH_SECRET', saved.gate],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('refuses a destructive command without ever reaching the shell', async () => {
    let called = false
    const tools = toolsWith(async () => {
      called = true
      return { stdout: '', stderr: '' }
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'rm -rf /' })

    assert.strictEqual(called, false)
    assert.strictEqual(outcome.status, 'error')
    assert.match(outcome.result, /Refused by the gateway tool policy: recursive force delete/)
  })

  it('truncates long output at the policy limit', async () => {
    const tools = toolsWith(async () => ({ stdout: 'A'.repeat(500), stderr: '' }))
    const outcome = await find(tools, 'run_bash').execute({ command: 'cat big.txt' })

    assert.ok(outcome.result.includes('truncated at 50 characters'))
  })

  it('reports a failed command as an error result rather than throwing', async () => {
    const tools = toolsWith(async () => {
      throw new Error('Command failed: nope')
    })

    const outcome = await find(tools, 'run_bash').execute({ command: 'nope' })

    assert.strictEqual(outcome.status, 'error')
    assert.match(outcome.result, /Execution failed: Command failed: nope/)
  })

  it('parses search results out of the html', async () => {
    const html = `
      <div class="result__body">
        <a class="result__a" href="#">First <b>hit</b></a>
        <a class="result__snippet">Something &amp; useful</a>
      </div>
      <div class="result__body">
        <a class="result__a" href="#">Second hit</a>
        <a class="result__snippet">More detail</a>
      </div>`

    const tools = toolsWith(undefined, async () => html)
    const outcome = await find(tools, 'search_web').execute({ query: 'anything' })

    assert.strictEqual(outcome.status, 'success')
    assert.match(outcome.result, /Title: First hit/)
    assert.match(outcome.result, /Snippet: Something & useful/)
    assert.match(outcome.result, /Title: Second hit/)
  })

  it('says so when the search finds nothing', async () => {
    const tools = toolsWith(undefined, async () => '<html></html>')
    const outcome = await find(tools, 'search_web').execute({ query: 'anything' })

    assert.strictEqual(outcome.result, 'No results found.')
  })

  it('rejects an empty query and reports a failing fetch', async () => {
    const tools = toolsWith(undefined, async () => {
      throw new Error('offline')
    })

    assert.strictEqual((await find(tools, 'search_web').execute({ query: '  ' })).status, 'error')
    assert.match((await find(tools, 'search_web').execute({ query: 'x' })).result, /Search failed: offline/)
  })

  describe('agente de projeto: o cerco', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'gw-local-project-'))
    const previousDb = process.env.CONVERSATIONS_DB
    before(() => (process.env.CONVERSATIONS_DB = join(dataRoot, 'gateway.db')))
    after(() => {
      process.env.CONVERSATIONS_DB = previousDb
      rmSync(dataRoot, { recursive: true, force: true })
    })
    const sandbox = (available: boolean) => ({
      status: async () => ({ available, mechanism: 'seatbelt' as const }),
      wrap: async (command: string) => {
        if (!available) throw new Error('cerco indisponível neste servidor: bwrap: No permissions to create new namespace')
        return `cercado(${command})`
      },
    })

    it('⛔ o comando sai embrulhado, no bash, na pasta do projeto — que vence o BASH_CWD', async () => {
      let seen: { command: string; options: IExecOptions } | undefined
      const tools = makeLocalTools({
        exec: async (command, options) => ((seen = { command, options }), { stdout: 'ok', stderr: '' }),
        fetchHtml: async () => '',
        policy,
        sandbox: sandbox(true),
      })
      const outcome = await find(tools, 'run_bash').execute({ command: 'ls' }, { sessionId: 's1', projectId: 'xpto' })
      assert.strictEqual(outcome.status, 'success')
      assert.deepStrictEqual([seen?.command, seen?.options.shell, seen?.options.cwd], ['cercado(ls)', '/bin/bash', join(dataRoot, 'projects', 'xpto')])
    })

    it('⛔ sem cerco, recusa e não roda nada', async () => {
      let ran = false
      const tools = makeLocalTools({ exec: async () => ((ran = true), { stdout: '', stderr: '' }), fetchHtml: async () => '', policy, sandbox: sandbox(false) })
      const outcome = await find(tools, 'run_bash').execute({ command: 'ls' }, { projectId: 'xpto' })
      assert.deepStrictEqual([outcome.status, ran], ['error', false])
      assert.match(String(outcome.result), /No permissions.*bloqueado/)
    })
  })
})

describe('LocalTools — read_doc', () => {
  const doc = { id: 'api', kind: 'adr' as const, projectId: 'xpto', title: 'API', summary: 'REST', body: '# Decisão', createdAt: new Date(), updatedAt: new Date() }

  it('só existe com o leitor de documentos; lê pelo projeto DA CONVERSA', async () => {
    assert.ok(!makeLocalTools().some((tool) => tool.name === 'read_doc'))
    const asked: Array<string | undefined> = []
    const tool = makeLocalTools({ docs: { readDoc: (id, projectId) => (asked.push(projectId), id === 'api' && projectId === 'xpto' ? doc : undefined) } }).find(
      (item) => item.name === 'read_doc',
    )!

    assert.deepStrictEqual(await tool.execute({ id: 'api' }, { conversationProjectId: 'xpto', projectId: 'outro' }), { status: 'success', result: '# API [adr]\n\n# Decisão' })
    assert.deepStrictEqual(await tool.execute({ id: 'api' }, {}), { status: 'error', result: 'Document not found: api' })
    assert.deepStrictEqual(asked, ['xpto', undefined])
  })
})

describe('LocalTools — use_skill', () => {
  it('só existe com o carregador de skills; carrega pelo agente DA CHAMADA', async () => {
    assert.ok(!makeLocalTools().some((tool) => tool.name === 'use_skill'))
    const tool = makeLocalTools({ skills: { loadSkill: (id, agentId) => (id === 'tabela' && agentId === 'dev' ? '# Skill: tabela' : undefined) } }).find(
      (item) => item.name === 'use_skill',
    )!
    assert.deepStrictEqual(await tool.execute({ id: 'tabela' }, { agentId: 'dev' }), { status: 'success', result: '# Skill: tabela' })
    assert.deepStrictEqual(await tool.execute({ id: 'tabela' }, { agentId: 'outro' }), { status: 'error', result: 'Skill not found: tabela' })
  })
})

describe('LocalTools — propose_draft', () => {
  const guidance = () => {
    const service = new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => id === 'xpto')
    service.createResource({ id: 'resumir', kind: 'command', description: 'Resume', body: 'Resuma $ARGUMENTS' }, 'root')
    return service
  }
  const toolOf = (service: GuidanceService) => makeLocalTools({ drafts: service }).find((item) => item.name === 'propose_draft')!

  it('só existe com o conferente, e só o construtor propõe (o tipo vem do agente)', async () => {
    assert.ok(!makeLocalTools().some((tool) => tool.name === 'propose_draft'))
    const result = await toolOf(guidance()).execute({ id: 'nova', description: 'd', body: 'b' }, { agentId: 'atlas' })
    assert.deepStrictEqual(result, { status: 'error', result: 'propose_draft is only for the core builder.' })
  })

  it('⛔ devolve os problemas ao modelo; aceita o rascunho válido — e nada é gravado', async () => {
    const service = guidance()
    const tool = toolOf(service)
    const wrong = await tool.execute({ id: 'resumir', description: '', body: 'b' }, { agentId: 'builder-skill', conversationProjectId: 'xpto' })
    assert.strictEqual(wrong.status, 'error')
    assert.match(String(wrong.result), /- id: already taken by a command: resumir\n- description: required/)

    const right = await tool.execute({ id: 'xpto-revisar', description: 'Revisa', body: 'Passos' }, { agentId: 'builder-skill', conversationProjectId: 'xpto' })
    assert.deepStrictEqual(right.status, 'success')
    assert.match(String(right.result), /new skill xpto-revisar, project xpto\)\. Nothing was saved/)
    assert.deepStrictEqual(service.resources('xpto'), [])

    const adjust = await toolOf(service).execute({ id: 'resumir', description: 'Resume melhor', body: 'Resuma $ARGUMENTS', global: true }, { agentId: 'builder-command' })
    assert.match(String(adjust.result), /adjusts the existing command resumir, global/)
    assert.strictEqual(service.resource('resumir').description, 'Resume')
  })

  it('spec e rule: os campos de cada tipo; a rule sem título volta com o problema', async () => {
    const tool = toolOf(guidance())
    const spec = await tool.execute({ id: 'api-rest', title: 'API REST', summary: 'Padrões de API', body: '# API' }, { agentId: 'builder-spec', conversationProjectId: 'xpto' })
    assert.match(String(spec.result), /new spec api-rest, project xpto\)\. Nothing was saved.*only after they confirm/)
    const rule = await tool.execute({ body: 'Nunca apague sem backup.' }, { agentId: 'builder-rule' })
    assert.deepStrictEqual([rule.status, /- title: required/.test(String(rule.result))], ['error', true])
  })
})
