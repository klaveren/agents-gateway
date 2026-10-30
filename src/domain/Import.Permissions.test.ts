import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { confirmedRules, IReachLine, ruleKey, translatePermission, translateReach } from './Import.Permissions'
import { decide, IPermissionRule, permissionIssues } from './Permission.Policy'

const one = (permission: Record<string, unknown>, options = {}) => translatePermission(permission, options)
const rulesOf = (lines: IReachLine[]) => lines.flatMap((line) => line.rules.map((rule) => `${rule.category} ${rule.pattern} ${rule.decision}`))
const statusOf = (lines: IReachLine[]) => lines.map((line) => line.status)
const allows = (rules: IPermissionRule[], category: IPermissionRule['category'], value: string) =>
  decide({ category, value, argv: category === 'terminal' ? value.split(' ') : undefined }, { agent: rules }).allowed

describe('Import.Permissions — terminal: do glob sobre a string para palavras', () => {
  it('o `*` colado no fim cobre os argumentos; antes de opção, separa a palavra', () => {
    const lines = one({ bash: { '*': 'allow', 'git rebase*': 'deny', 'git push*--force*': 'deny', 'git push * main*': 'deny', 'pnpm add*': 'deny' } })
    assert.deepStrictEqual(rulesOf(lines), [
      'terminal * allow',
      'terminal git rebase* * deny',
      'terminal git push * --force* * deny',
      'terminal git push * main* * deny',
      'terminal pnpm add* * deny',
    ])
    assert.deepStrictEqual(statusOf(lines), ['direct', 'direct', 'direct', 'direct', 'direct'])
    const rules = lines.flatMap((line) => line.rules)
    assert.strictEqual(allows(rules, 'terminal', 'git rebase -i main'), false)
    assert.strictEqual(allows(rules, 'terminal', 'git push origin main -u'), false)
    assert.strictEqual(allows(rules, 'terminal', 'git push origin feat --force-with-lease'), false)
    assert.strictEqual(allows(rules, 'terminal', 'git push origin feat'), true)
  })

  it('opção curta separada muda de sentido (⚠️): no opencode casava dentro de qualquer palavra', () => {
    const [line] = one({ bash: { 'git push*-f*': 'deny' } })
    assert.deepStrictEqual([line.rules[0].pattern, line.status], ['git push * -f* *', 'changed'])
  })

  it('o `*` inicial sai; sozinho numa palavra vira "em qualquer argumento"', () => {
    const lines = one({ bash: { '*git stash pop*': 'deny', '*.credentials*': 'deny' } })
    assert.deepStrictEqual(rulesOf(lines), ['terminal git stash pop* * deny', 'terminal * *.credentials* * deny'])
    assert.deepStrictEqual(statusOf(lines), ['direct', 'changed'])
    assert.strictEqual(allows([{ category: 'terminal', pattern: '*', decision: 'allow' }, ...lines.flatMap((line) => line.rules)], 'terminal', 'cat a/.credentials/k -n'), false)
  })

  it('redirecionamento não vira regra (⚠️, o gateway checa como escrita); linha composta e `?` são ❌; `**` vira `*`', () => {
    const lines = one({ bash: { '* > *': 'deny', 'a | b': 'deny', 'ls ?': 'allow', '**': 'allow' } })
    assert.deepStrictEqual(statusOf(lines), ['changed', 'none', 'none', 'direct'])
    assert.deepStrictEqual(rulesOf(lines), ['terminal * allow'])
  })
})

describe('Import.Permissions — última vence → negar vence', () => {
  it('`deny *` seguido de `allow x` → só `allow x` (⚠️ na negação omitida)', () => {
    const lines = one({ skill: { '*': 'deny', 'akm-*': 'allow' } })
    assert.deepStrictEqual(rulesOf(lines), ['skill akm-* allow'])
    assert.deepStrictEqual(statusOf(lines), ['changed', 'direct'])
  })

  it('negação de base sem liberação depois fica (senão o projeto decidiria)', () => {
    assert.deepStrictEqual(rulesOf(one({ mcp: { '*': 'deny' } })), ['mcp * deny'])
  })

  it('negação estreita desfeita por uma liberação posterior fica e é marcada (falha fechada)', () => {
    const [deny, allow] = one({ bash: { 'git push*': 'deny', 'git push origin feat*': 'allow' } })
    assert.deepStrictEqual([deny.rules[0].pattern, deny.status], ['git push* *', 'changed'])
    assert.match(deny.reason, /negar vence/)
    assert.strictEqual(allow.rules.length, 1)
  })

  it('liberação que uma negação posterior mata não entra (❌, morta já no opencode)', () => {
    const lines = one({ skill: { 'akm-x': 'allow', 'akm-*': 'deny' } })
    assert.deepStrictEqual(statusOf(lines), ['none', 'direct'])
    assert.deepStrictEqual(rulesOf(lines), ['skill akm-* deny'])
  })

  it('`ask` vira negar (⚠️): o gateway não pergunta', () => {
    const [line] = one({ bash: { 'rm *': 'ask' } })
    assert.deepStrictEqual([line.rules[0].decision, line.status], ['deny', 'changed'])
  })

  it('valor em texto vale para tudo; chave sem equivalente é ❌', () => {
    const lines = one({ webfetch: 'allow', edit: 'deny' })
    assert.deepStrictEqual(statusOf(lines), ['none', 'direct'])
    assert.deepStrictEqual(rulesOf(lines), ['write ** deny'])
  })
})

describe('Import.Permissions — caminhos', () => {
  it('`edit` e `write` viram `write`; `** deny` de base nunca entra; nome sem `/` vale em qualquer pasta (⚠️)', () => {
    const lines = one({ edit: { '**': 'deny', 'start.sh': 'allow', '.agents/**': 'allow' }, write: { 'tmp/**': 'allow' } })
    assert.deepStrictEqual(rulesOf(lines), ['write start.sh allow', 'write .agents/** allow', 'write tmp/** allow'])
    assert.deepStrictEqual(statusOf(lines), ['changed', 'changed', 'direct', 'direct'])
  })

  it('o par `X` + `**/X` é ✅ e o segundo é coberto; repetição entre `edit` e `write` sai', () => {
    const lines = one({
      edit: { 'README.md': 'allow', '**/README.md': 'allow', 'opencode.json': 'allow', 'w/*/opencode.json': 'allow', 'tmp/**': 'allow' },
      write: { 'tmp/**': 'allow' },
    })
    assert.deepStrictEqual(rulesOf(lines), ['write README.md allow', 'write opencode.json allow', 'write tmp/** allow'])
    assert.deepStrictEqual(statusOf(lines), ['direct', 'direct', 'changed', 'direct', 'direct', 'direct'])
  })

  it('⛔ `write ** allow` com `edit` em lista: omitido por padrão (❌); com a opção, entra como ampliação', () => {
    const permission = { edit: { '**': 'deny', 'a/**': 'allow' }, write: { '**': 'allow' } }
    const omitted = translateReach({ permission }, { readAll: false })
    assert.strictEqual(omitted.lines[2].status, 'none')
    assert.deepStrictEqual(omitted.rules, [{ category: 'write', pattern: 'a/**', decision: 'allow' }])
    const proposed = translateReach({ permission }, { readAll: false, createAnywhere: 'propose' })
    assert.deepStrictEqual(
      proposed.widenings.map((item) => ruleKey(item.rule)),
      ['write allow **'],
    )
    assert.deepStrictEqual(confirmedRules(proposed, []), [{ category: 'write', pattern: 'a/**', decision: 'allow' }])
  })

  it('pasta externa: negar é omitido (✅), liberar é ❌', () => {
    assert.deepStrictEqual(statusOf(one({ external_directory: { '**': 'deny', '/srv/**': 'allow' } })), ['direct', 'none'])
  })
})

describe('Import.Permissions — MCP e delegação', () => {
  const mcpServers = { srv: { id: 'dest' }, other: { id: 'other-id', tools: ['a', 'b'] } }

  it('`<servidor>_<tool>` vira `<id>/<tool>`; nome nu, servidor sem destino e fora da lista são ❌', () => {
    const lines = one(
      { mcp: { '*': 'deny', srv: 'allow', srv_x: 'allow', 'srv_m*': 'allow', srv_m_create: 'deny', ghost_y: 'allow', other_c: 'allow', other_a: 'allow' } },
      { mcpServers },
    )
    assert.deepStrictEqual(statusOf(lines), ['changed', 'none', 'direct', 'direct', 'direct', 'none', 'none', 'direct'])
    const rules = lines.flatMap((line) => line.rules)
    assert.deepStrictEqual(rulesOf(lines), ['mcp dest/x allow', 'mcp dest/m* allow', 'mcp dest/m_create deny', 'mcp other-id/a allow'])
    assert.strictEqual(allows(rules, 'mcp', 'dest/m_list'), true)
    assert.strictEqual(allows(rules, 'mcp', 'dest/m_create'), false)
    const kept = one({ mcp: { other_c: 'allow' } }, { mcpServers, outsideServerTools: 'keep' })
    assert.deepStrictEqual(rulesOf(kept), ['mcp other-id/c allow'])
  })

  it('o servidor inteiro é ampliação', () => {
    const [line] = one({ mcp: { 'srv*': 'allow' } }, { mcpServers })
    assert.deepStrictEqual([line.rules[0].pattern, Boolean(line.widening)], ['dest/*', true])
  })

  it('delegação: `agent:<id>` só para alvo que existe; o resto é ❌ "alvo não importado" (regra inerte)', () => {
    const result = translateReach(
      { permission: { task: { '*': 'deny', a: 'allow', b: 'allow', me: 'deny' } } },
      { agents: { a: 'pre-a', me: 'pre-me' }, self: 'me', readAll: false },
    )
    assert.deepStrictEqual(statusOf(result.lines), ['changed', 'direct', 'none', 'direct'])
    assert.match(result.lines[2].reason, /alvo não importado/)
    assert.deepStrictEqual(rulesOf(result.lines), ['delegate pre-a allow', 'delegate b allow', 'delegate pre-me deny'])
    assert.deepStrictEqual(result.allowedTools, ['agent:pre-a'])
  })
})

describe('Import.Permissions — opções de alcance e ampliações', () => {
  const project = {
    read: { '.credentials/**': 'deny', '**/.credentials/**': 'deny' },
    bash: { '*': 'deny', 'cat *.env': 'deny', 'tee *': 'deny', 'cat *': 'allow' },
    skill: { '*': 'allow', 'x-*': 'deny' },
  }

  it('sem regra de leitura: `read **` (ampliação) + as negações de leitura do projeto repostas no agente', () => {
    const result = translateReach({ permission: {} }, { project })
    assert.deepStrictEqual(rulesOf(result.added).slice(0, 2), ['read ** allow', 'read **/.credentials/** deny'])
    assert.deepStrictEqual(
      result.widenings.map((item) => ruleKey(item.rule)),
      ['read allow **'],
    )
    assert.strictEqual(allows(result.rules, 'read', 'a/.credentials/k'), false)
    assert.deepStrictEqual(translateReach({ permission: {} }, { project, readAll: false }).rules, [])
  })

  it('terminal amplo no agente repõe as negações do projeto; liberação igual à negação não repõe', () => {
    const result = translateReach({ permission: { bash: { '*': 'allow', 'tee *': 'deny' }, skill: { 'x-*': 'allow' } } }, { project, readAll: false })
    assert.deepStrictEqual(rulesOf(result.added), ['terminal cat *.env deny'])
    assert.strictEqual(result.added[0].origin, 'project')
    assert.strictEqual(result.added[0].status, 'direct')
    assert.strictEqual(allows(result.rules, 'skill', 'x-y'), true)
    assert.deepStrictEqual(translateReach({ permission: { bash: { '*': 'allow' } } }, { project, readAll: false, restoreProjectDenies: false }).added, [])
  })

  it('negação de base omitida avisa quando o projeto libera a categoria', () => {
    const result = translateReach({ permission: { skill: { '*': 'deny', 'a-*': 'allow' } } }, { project, readAll: false })
    assert.match(result.lines[0].reason, /o projeto libera `\*`/)
  })

  it('⛔ o módulo nunca aceita ampliação: sem confirmação, `confirmedRules` tira todas', () => {
    const result = translateReach({ permission: { bash: { '*': 'allow', 'sed *': 'deny' } } })
    assert.deepStrictEqual(
      result.widenings.map((item) => ruleKey(item.rule)),
      ['terminal allow *', 'read allow **'],
    )
    assert.deepStrictEqual(confirmedRules(result, []), [{ category: 'terminal', pattern: 'sed *', decision: 'deny' }])
    assert.strictEqual(confirmedRules(result, ['terminal allow *']).length, 2)
  })
})

describe('Import.Permissions — tools → allowedTools', () => {
  it('capacidade sai da ferramenta ligada E de uma liberação na categoria; a última chave vence', () => {
    const permission = { bash: { '*': 'allow' }, edit: { 'a/**': 'allow' } }
    assert.deepStrictEqual(translateReach({ permission }).allowedTools, ['cap:terminal', 'cap:files.read', 'cap:files.write'])
    assert.deepStrictEqual(translateReach({ permission, tools: { bash: false, write: false, edit: false } }).allowedTools, ['cap:files.read'])
    assert.deepStrictEqual(translateReach({ permission, tools: { '*': false, bash: true } }, { readAll: false }).allowedTools, ['cap:terminal'])
  })

  it('MCP: nome exato entra; glob só expande com a lista do servidor; desligada e negada ficam de fora', () => {
    const permission = { mcp: { 's_*': 'allow', s_m_create: 'deny' } }
    const tools = { 's*': false, s_a: true, 's_m*': true, s_m_create: false }
    const without = translateReach({ permission, tools }, { mcpServers: { s: { id: 'dest' } }, readAll: false })
    assert.deepStrictEqual(without.allowedTools, ['mcp:dest/a'])
    assert.deepStrictEqual(
      without.tools.map((line) => line.status),
      ['direct', 'direct', 'none', 'direct'],
    )
    const withList = translateReach({ permission, tools }, { mcpServers: { s: { id: 'dest', tools: ['a', 'b', 'm_list', 'm_create'] } }, readAll: false })
    assert.deepStrictEqual(withList.allowedTools, ['mcp:dest/a', 'mcp:dest/m_list'])
    assert.deepStrictEqual(withList.tools[2].tools, ['mcp:dest/m_list'])
  })
})

/**
 * ACEITAÇÃO: o `opencode.json` real do repositório de exemplo (o agente da Maya) contra o relatório feito à mão
 * (`docs/integration/maya-permissoes.md`: 88 ✅ / 14 ⚠️ / 15 ❌ nas 117 entradas). O CI não tem o repositório: pula.
 */
describe('Import.Permissions — aceitação com o opencode.json real', () => {
  const path = process.env.IMPORT_REACH_OPENCODE ?? '/Volumes/Data/repositories/infoccus/logiccus/opencode.json'
  const load = () => {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      permission: Record<string, unknown>
      agent: Record<string, { permission: Record<string, unknown>; tools: Record<string, unknown> }>
    }
    return { project: config.permission, agent: config.agent['agent-administrator'] }
  }
  const NAMED = [
    ...['list', 'get', 'get_audit', 'get_audit_entry', 'search', 'clusters', 'create', 'create_demand', 'create_incident', 'create_lane', 'create_request', 'open', 'enrich'].map(
      (t) => `ticket_${t}`,
    ),
    ...['reclassify', 'set_models', 'bulk_transition', 'resolve', 'close', 'reopen', 'return', 'reassign', 'cancel', 'reschedule', 'start'].map((t) => `ticket_${t}`),
    ...['list', 'get', 'search', 'get_stories', 'get_prd', 'get_audit', 'start', 'complete', 'escalate', 'reconcile'].map((t) => `epic_${t}`),
    'story_get_audit',
    'sprint_list',
    'sprint_search',
    'settings_get',
    'settings_set',
    ...['create', 'update', 'list', 'get', 'checkin'].map((t) => `schedule_${t}`),
  ]
  const MEETING = ['connect', 'get_messages', 'response', 'response_to', 'ask', 'conclude', 'get_last_summary', 'cancel', 'set_ata', 'get_ata'].map((t) => `meeting_${t}`)

  it('as 117 entradas da Maya batem com o relatório à mão (88 / 14 / 15)', (t) => {
    if (!existsSync(path)) return t.skip(`sem ${path} (defina IMPORT_REACH_OPENCODE para rodar)`)
    const { project, agent } = load()
    const result = translateReach(agent, { mcpServers: { logiccus: { id: 'logiccus' } }, project, self: 'agent-administrator' })
    assert.strictEqual(result.lines.length, 117)
    assert.deepStrictEqual(result.totals, { direct: 88, changed: 14, none: 15 })
    // Por categoria, como no relatório (bash, edit, write, skill, mcp, task, external_directory).
    const byKey = (key: string) => statusOf(result.lines.filter((line) => line.key === key)).join(',')
    const count = (key: string) =>
      ['direct', 'changed', 'none'].map(
        (status) =>
          byKey(key)
            .split(',')
            .filter((item) => item === status).length,
      )
    assert.deepStrictEqual(['bash', 'edit', 'write', 'skill', 'mcp', 'task', 'external_directory'].map(count), [
      [19, 3, 0],
      [15, 8, 0],
      [1, 0, 1],
      [5, 1, 0],
      [46, 1, 1],
      [1, 1, 13],
      [1, 0, 0],
    ])
    assert.deepStrictEqual(permissionIssues(result.rules), [])
    assert.ok(!result.rules.some((rule) => rule.pattern === '**' && rule.category === 'write'), '`write **` nunca entra')
    assert.ok(!result.rules.some((rule) => rule.decision === 'deny' && ['**', '*'].includes(rule.pattern) && rule.category !== 'mcp'), '`** deny` de base nunca entra')
    // As escolhas do dono: `write **` omitido, `read **` + `**/.credentials/**`, negações do terminal do projeto repostas.
    assert.deepStrictEqual(
      result.widenings.map((item) => ruleKey(item.rule)),
      ['terminal allow *', 'read allow **'],
    )
    assert.ok(result.rules.some((rule) => ruleKey(rule) === 'read deny **/.credentials/**'))
    assert.ok(result.added.some((line) => line.origin === 'project' && line.rules.some((rule) => rule.pattern === '* *.credentials* *')))
    // Sem a lista do servidor o glob `meeting*` não expande: 3 capacidades + as 44 com nome.
    assert.strictEqual(result.allowedTools.length, 3 + NAMED.length)
  })

  it('com a lista do servidor sem ticket_start/close/reopen (decisão do dono): elas viram ❌ e o meeting* expande', (t) => {
    if (!existsSync(path)) return t.skip(`sem ${path} (defina IMPORT_REACH_OPENCODE para rodar)`)
    const { project, agent } = load()
    const out = ['ticket_start', 'ticket_close', 'ticket_reopen']
    const tools = [...NAMED.filter((name) => !out.includes(name)), ...MEETING, 'meeting_create']
    const result = translateReach(agent, { mcpServers: { logiccus: { id: 'logiccus', tools } }, project, self: 'agent-administrator' })
    assert.deepStrictEqual(result.totals, { direct: 85, changed: 14, none: 18 })
    assert.strictEqual(result.allowedTools.length, 3 + NAMED.length - out.length + MEETING.length)
    assert.ok(!result.allowedTools.includes('mcp:logiccus/meeting_create'))
    assert.ok(!result.allowedTools.some((tool) => out.some((name) => tool.endsWith(`/${name}`))))
  })
})
