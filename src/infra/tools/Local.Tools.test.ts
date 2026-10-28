import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeLocalTools, type IExecOptions, type TExec } from './Local.Tools'
import { realOf } from './File.Tools'
import type { IPermissionChecker } from '@application/Permissions.Service'
import type { ICercoPlan } from '@domain/Cerco.Plan'
import { decide, type IPermissionRule } from '@domain/Permission.Policy'
import { networkGate } from '@infra/permissions/Network.Gate'
import type { IProjectSandbox } from '@infra/sandbox/Project.Sandbox'
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

  it('exposes exactly the built-in tools: web, terminal and the files', () => {
    assert.deepStrictEqual(
      toolsWith().map((tool) => tool.name),
      ['search_web', 'run_bash', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file'],
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

  describe('⛔ com permissões: a análise por partes, o cerco das regras e a rede', () => {
    const root = mkdtempSync(join(tmpdir(), 'gw-local-perm-'))
    after(() => rmSync(root, { recursive: true, force: true }))
    const rule = (category: IPermissionRule['category'], pattern: string, decision: IPermissionRule['decision'] = 'allow'): IPermissionRule => ({ category, pattern, decision })
    const checker = (agent: IPermissionRule[]): IPermissionChecker => ({ check: (_asker, subject) => decide(subject, { agent }), layers: () => ({ agent, system: [] }) })
    const setup = (agent: IPermissionRule[], during?: (token: string) => Promise<void>) => {
      const seen: { ran: string[]; plan?: ICercoPlan; token?: string } = { ran: [] }
      const sandbox: IProjectSandbox = {
        status: async () => ({ available: true, mechanism: 'seatbelt' }),
        wrap: async () => assert.fail('o cerco fixo não vale com permissões'),
        wrapWith: async (command, cercoRoot, plan, token) => {
          seen.plan = plan({ root: cercoRoot, scratch: [join(cercoRoot, '.home')], alwaysRead: [], alwaysDeny: ['/home/gw'] })
          seen.token = token
          return `cercado(${command})`
        },
      }
      const tools = makeLocalTools({
        exec: async (command) => (seen.ran.push(command), await during?.(seen.token!), { stdout: 'ok', stderr: '' }),
        fetchHtml: async () => '',
        policy: { ...policy, cwd: root },
        sandbox,
        permissions: checker(agent),
      })
      return { seen, run: (command: string) => find(tools, 'run_bash').execute({ command }, { sessionId: 's1', agentId: 'dev' }) }
    }

    it('cada comando da linha passa pela regra: o permitido não leva o negado junto', async () => {
      const { seen, run } = setup([rule('terminal', 'git *')])
      const outcome = await run('git status; rm notas.txt')
      assert.deepStrictEqual([outcome.status, seen.ran], ['error', []])
      assert.match(outcome.result, /Not permitted: .*"rm notas.txt"/)
      assert.strictEqual((await run('git status && git log -1')).status, 'success')
    })

    it('o que não dá para analisar é negado, mesmo com o terminal liberado', async () => {
      const { seen, run } = setup([rule('terminal', '*')])
      assert.match((await run('eval "$CMD"')).result, /não dá para analisar/)
      assert.deepStrictEqual(seen.ran, [])
    })

    it('o redirecionamento é escrita: sem regra de escrita, negado; com ela, o cerco grava só ali', async () => {
      assert.match((await setup([rule('terminal', 'echo *')]).run('echo oi > notas.txt')).result, /nenhuma regra de escrita/)
      const { seen, run } = setup([rule('terminal', 'echo *'), rule('write', '*.txt')])
      assert.strictEqual((await run('echo oi > notas.txt')).status, 'success')
      assert.deepStrictEqual(seen.ran, ['cercado(echo oi > notas.txt)'])
      assert.ok(seen.plan?.writeAllow.includes(join(realOf(root), '**/*.txt')))
      assert.ok(seen.plan?.readDeny.includes(realOf(root)) && seen.plan.readDeny.includes('/home/gw'))
    })

    it('a rede do comando: o destino que a regra libera passa, o resto não; acabou o comando, o token morre', async () => {
      const verdicts: boolean[] = []
      const { seen, run } = setup([rule('terminal', 'curl *'), rule('network', '93.184.215.14:443')], async (token) => {
        for (const [host, port] of [
          ['93.184.215.14', 443],
          ['evil.example', 443],
          ['127.0.0.1', 443],
        ] as const)
          verdicts.push((await networkGate().decide(token, host, port)).allowed)
      })
      assert.strictEqual((await run('curl -s https://93.184.215.14')).status, 'success')
      assert.deepStrictEqual(verdicts, [true, false, false])
      assert.strictEqual((await networkGate().decide(seen.token, '93.184.215.14', 443)).allowed, false)
    })

    it('sem o cerco das regras no servidor, o terminal fica bloqueado', async () => {
      const tools = makeLocalTools({
        exec: async () => assert.fail('não roda'),
        policy: { ...policy, cwd: root },
        sandbox: { status: async () => ({ available: true, mechanism: 'seatbelt' }), wrap: async () => 'x' },
        permissions: checker([rule('terminal', '*')]),
      })
      assert.match((await find(tools, 'run_bash').execute({ command: 'ls' })).result, /bloqueado/)
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

describe('LocalTools — search_docs', () => {
  it('só existe quando quem lê também busca; busca no projeto DA CONVERSA e devolve o trecho', async () => {
    assert.ok(!makeLocalTools({ docs: { readDoc: () => undefined } }).some((tool) => tool.name === 'search_docs'))
    const asked: Array<[string, string | undefined, string | undefined]> = []
    const tool = makeLocalTools({
      docs: {
        readDoc: () => undefined,
        searchDocs: (query, projectId, kind) => (
          asked.push([query, projectId, kind]),
          [{ id: 'api', kind: 'spec' as const, title: 'API', summary: 'Rotas', excerpt: 'erros com «código»' }]
        ),
      },
    }).find((item) => item.name === 'search_docs')!
    const result = await tool.execute({ query: 'código', kind: 'spec' }, { conversationProjectId: 'xpto' })
    assert.deepStrictEqual(result, { status: 'success', result: '- [spec] api — API: Rotas\n  …erros com «código»…' })
    assert.deepStrictEqual(asked, [['código', 'xpto', 'spec']])
    assert.strictEqual((await tool.execute({ query: ' ' }, {})).status, 'error')
  })
})

describe('LocalTools — propose_draft de agente', () => {
  it('confere o registro, o contexto inicial e os recursos; aceita o válido sem gravar', async () => {
    const drafts = {
      draftIssues: () => ({ issues: [], updates: false }),
      agentDraftIssues: async (draft: { agent?: Record<string, unknown> }) =>
        draft.agent?.name
          ? { issues: [], updates: false, id: String(draft.agent.id), projectId: 'xpto' }
          : { issues: [{ field: 'agent.name', message: 'required' }], updates: false },
    }
    const tool = makeLocalTools({ drafts }).find((item) => item.name === 'propose_draft')!
    const wrong = await tool.execute({ agent: { id: 'revisor' } }, { agentId: 'builder-agent' })
    assert.match(String(wrong.result), /- agent\.name: required/)
    const right = await tool.execute({ agent: { id: 'revisor', name: 'Revisor' }, initialContext: ['api'], resources: { skills: ['*'] } }, { agentId: 'builder-agent' })
    assert.match(String(right.result), /new agent revisor, project xpto\)\. Nothing was saved/)
  })
})

describe('update_todos', () => {
  const tool = (saveTodos: (sessionId: string, items: unknown) => Promise<void>) => makeLocalTools({ todos: { saveTodos } }).find((item) => item.name === 'update_todos')!

  it('grava a lista inteira na conversa e devolve o estado ao modelo', async () => {
    const saved: unknown[] = []
    const update = tool(async (sessionId, items) => void saved.push([sessionId, items]))
    const out = await update.execute(
      {
        items: [
          { title: ' Ler ', status: 'done' },
          { title: 'Escrever', status: 'in_progress' },
        ],
      },
      { sessionId: 'conv-1' },
    )
    assert.deepStrictEqual(out, { status: 'success', result: 'Tasks (1/2 done):\n[x] Ler\n[~] Escrever' })
    assert.deepStrictEqual(saved, [
      [
        'conv-1',
        [
          { title: 'Ler', status: 'done' },
          { title: 'Escrever', status: 'in_progress' },
        ],
      ],
    ])
  })

  it('⛔ recusa lista inválida sem gravar; fora de conversa é erro; falha ao gravar volta como erro', async () => {
    let calls = 0
    const update = tool(async () => void (calls += 1))
    const invalid = await update.execute({ items: [{ title: 'A', status: 'feito' }] }, { sessionId: 'conv-1' })
    assert.strictEqual(invalid.status, 'error')
    assert.match(invalid.result, /status/)
    assert.strictEqual((await update.execute({ items: [{ title: 'A', status: 'pending' }] })).status, 'error')
    assert.strictEqual(calls, 0)
    const broken = tool(async () => {
      throw new Error('FOREIGN KEY constraint failed')
    })
    assert.match((await broken.execute({ items: [{ title: 'A', status: 'pending' }] }, { sessionId: 'x' })).result, /Could not save/)
  })

  it('sem onde gravar, a ferramenta não existe', () => {
    assert.ok(!makeLocalTools({}).some((item) => item.name === 'update_todos'))
  })
})
