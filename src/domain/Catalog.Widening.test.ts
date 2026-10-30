import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentDocument, IAgentLinks, ICatalogDocument, mcpDocument, projectPermissionsDocument, resourceDocument, ruleDocument } from './Catalog.Document'
import { confirmsWidenings, IWidening, patternCovers, wideningKeys, wideningsOf } from './Catalog.Widening'
import { EMode } from './enums/EMode.Enum'
import { IAgent } from './models/Agent.Model'
import { IMcpServerConfig } from './models/McpServer.Model'
import { IPermissionRule, TPermissionCategory } from './Permission.Policy'

const at = new Date('2026-10-30T12:00:00.000Z')

const baseAgent: IAgent = {
  id: 'theo',
  name: 'Theo',
  providers: [{ provider: 'claude', models: ['opus'] }],
  systemPrompt: 'Faça X.',
  modes: [EMode.CHAT, EMode.AGENT],
  allowedTools: ['cap:files.read', 'mcp:gh/list_issues'],
  adminOnly: true,
  role: 'subagent',
  projectId: 'alfa',
  permissions: [
    { category: 'terminal', pattern: 'git *', decision: 'allow' },
    { category: 'read', pattern: '**/.env', decision: 'deny' },
  ],
  triggers: [{ id: 'deploy', when: 'Ao subir', body: 'Rode o deploy.' }],
  env: { LANG: 'pt_BR.UTF-8' },
}
const baseLinks: IAgentLinks = { resources: { skills: ['revisar'], commands: [] }, initialContext: [] }

const agentDoc = (patch: Partial<IAgent> = {}, links: Partial<IAgentLinks> = {}) => agentDocument({ ...baseAgent, ...patch }, { ...baseLinks, ...links })

const baseMcp: IMcpServerConfig = {
  id: 'n8n',
  projectId: 'alfa',
  name: 'n8n',
  kind: 'container',
  container: { image: 'n8n/mcp:1', args: [], writable: ['/tmp'], memoryMb: 512, cpus: 1, network: 'none', allowedHosts: [], env: [] },
  url: '',
  transport: 'auto',
  auth: 'none',
  enabled: true,
  createdAt: at,
  updatedAt: at,
}
const mcpDoc = (patch: Partial<IMcpServerConfig> = {}) => mcpDocument({ ...baseMcp, ...patch })
const container = (patch: Partial<NonNullable<IMcpServerConfig['container']>>) => ({ container: { ...baseMcp.container!, ...patch } })

const rules = (...items: Array<[TPermissionCategory, string, 'allow' | 'deny']>): IPermissionRule[] =>
  items.map(([category, pattern, decision]) => ({ category, pattern, decision }))
const projectDoc = (...items: Array<[TPermissionCategory, string, 'allow' | 'deny']>) => projectPermissionsDocument('alfa', rules(...items))

const keysOf = (before: ICatalogDocument | undefined, after: ICatalogDocument | undefined) => wideningKeys(wideningsOf(before, after))

describe('Catalog.Widening — agente', () => {
  it('nada mudou → nada amplia', () => {
    assert.deepStrictEqual(wideningsOf(agentDoc(), agentDoc()), [])
  })

  it('só "atenção" não amplia: prompt, soul, modelo, provider, terminal, contexto inicial', () => {
    const after = agentDoc(
      { systemPrompt: 'Outra coisa.', soul: 'Outro.', providers: [{ provider: 'openai', models: ['gpt'] }], terminal: { timeoutSeconds: 600 }, name: 'T' },
      { initialContext: ['visao'] },
    )
    assert.deepStrictEqual(keysOf(agentDoc(), after), [])
  })

  it('allowedTools: ferramenta nova amplia; tirar não; agent: novo é delegação', () => {
    const widenings = wideningsOf(agentDoc(), agentDoc({ allowedTools: ['cap:terminal', 'agent:maya'] }))
    assert.deepStrictEqual(
      widenings.map((item) => [item.category, item.key]),
      [
        ['delegation', 'agent/theo@alfa#allowedTools+agent:maya'],
        ['tool', 'agent/theo@alfa#allowedTools+cap:terminal'],
      ],
    )
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ allowedTools: ['cap:files.read'] })), [])
  })

  it('allowedTools: mcp:<srv>/* cobre a ferramenta do mesmo servidor, e o /* novo amplia', () => {
    assert.deepStrictEqual(keysOf(agentDoc({ allowedTools: ['mcp:gh/*'] }), agentDoc({ allowedTools: ['mcp:gh/create_pr'] })), [])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ allowedTools: ['mcp:gh/*'] })), ['agent/theo@alfa#allowedTools+mcp:gh/*'])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ allowedTools: ['mcp:outro/list_issues'] })), ['agent/theo@alfa#allowedTools+mcp:outro/list_issues'])
  })

  it('lane com ferramenta nova amplia num agente que tem ferramentas; lane de chat, não', () => {
    assert.deepStrictEqual(keysOf(agentDoc({ modes: [EMode.CHAT] }), agentDoc()), ['agent/theo@alfa#modes+agent'])
    assert.deepStrictEqual(keysOf(agentDoc({ modes: [EMode.AGENT] }), agentDoc()), [])
    assert.deepStrictEqual(keysOf(agentDoc({ modes: [EMode.CHAT], allowedTools: [] }), agentDoc({ allowedTools: [] })), [])
  })

  it('permissions: allow novo amplia; allow mais amplo amplia; allow mais estreito não', () => {
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: [] }), agentDoc({ permissions: rules(['terminal', 'npm test', 'allow']) })), [
      'agent/theo@alfa#permissions+allow:terminal:npm test',
    ])
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: rules(['terminal', 'git push *', 'allow']) }), agentDoc({ permissions: rules(['terminal', 'git *', 'allow']) })), [
      'agent/theo@alfa#permissions+allow:terminal:git *',
    ])
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: rules(['terminal', 'git *', 'allow']) }), agentDoc({ permissions: rules(['terminal', 'git push *', 'allow']) })), [])
  })

  it('permissions: deny removido amplia; deny estreitado amplia; deny novo e allow removido não', () => {
    const before = agentDoc({ permissions: rules(['read', 'secrets/**', 'deny'], ['terminal', 'npm *', 'allow']) })
    assert.deepStrictEqual(keysOf(before, agentDoc({ permissions: rules(['terminal', 'npm *', 'allow']) })), ['agent/theo@alfa#permissions-deny:read:secrets/**'])
    const narrowed = wideningsOf(before, agentDoc({ permissions: rules(['read', 'secrets/prod/**', 'deny'], ['terminal', 'npm *', 'allow']) }))
    assert.deepStrictEqual(wideningKeys(narrowed), ['agent/theo@alfa#permissions-deny:read:secrets/**'])
    assert.match(narrowed[0].description, /estreita a negação/)
    assert.deepStrictEqual(keysOf(before, agentDoc({ permissions: rules(['read', '**', 'deny']) })), [])
  })

  it('permissions: reordenar, mudar nota e aparar espaço não amplia; mudar a categoria amplia', () => {
    const items = rules(['terminal', 'git *', 'allow'], ['read', 'docs/**', 'deny'])
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: items }), agentDoc({ permissions: [...items].reverse().map((rule) => ({ ...rule, note: 'x' })) })), [])
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: items }), agentDoc({ permissions: [{ ...items[0], pattern: ' git * ' }, items[1]] })), [])
    assert.deepStrictEqual(keysOf(agentDoc({ permissions: items }), agentDoc({ permissions: [{ ...items[0], category: 'write' }, items[1]] })), [
      'agent/theo@alfa#permissions+allow:write:git *',
    ])
  })

  it('adminOnly true → false amplia; false → true não', () => {
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ adminOnly: false })), ['agent/theo@alfa#adminOnly-'])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ adminOnly: undefined })), ['agent/theo@alfa#adminOnly-'])
    assert.deepStrictEqual(keysOf(agentDoc({ adminOnly: false }), agentDoc()), [])
  })

  it('role: sair de subagent amplia; virar subagent não', () => {
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ role: undefined })), ['agent/theo@alfa#role-subagent'])
    assert.deepStrictEqual(keysOf(agentDoc({ role: undefined }), agentDoc()), [])
  })

  it('projectId: virar global amplia; mudar de projeto amplia; global → projeto não', () => {
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ projectId: undefined })), ['agent/theo#projectId-'])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ projectId: 'beta' })), ['agent/theo@beta#projectId~beta'])
    assert.deepStrictEqual(keysOf(agentDoc({ projectId: undefined }), agentDoc()), [])
  })

  it('sandbox mais solto e rede ligada ampliam; mais fechado não', () => {
    const target = (sandbox?: 'read-only' | 'workspace-write' | 'full', network?: boolean) => ({ providers: [{ provider: 'claude', models: ['opus'], sandbox, network }] })
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc(target('workspace-write'))), ['agent/theo@alfa#providers.claude.sandbox~workspace-write'])
    assert.deepStrictEqual(keysOf(agentDoc(target('workspace-write')), agentDoc(target('full', true))), [
      'agent/theo@alfa#providers.claude.network+',
      'agent/theo@alfa#providers.claude.sandbox~full',
    ])
    assert.deepStrictEqual(keysOf(agentDoc(target('full', true)), agentDoc(target('read-only'))), [])
    // Provider novo é comparado com o padrão.
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ providers: [...baseAgent.providers, { provider: 'openai', models: ['gpt'], sandbox: 'full' }] })), [
      'agent/theo@alfa#providers.openai.sandbox~full',
    ])
  })

  it('resources: de restrito para * amplia; id novo amplia; de * para lista não', () => {
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({}, { resources: { skills: ['*'], commands: [] } })), ['agent/theo@alfa#resources.skills+*'])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({}, { resources: { skills: ['revisar', 'commitar'], commands: ['deploy'] } })), [
      'agent/theo@alfa#resources.commands+deploy',
      'agent/theo@alfa#resources.skills+commitar',
    ])
    assert.deepStrictEqual(keysOf(agentDoc({}, { resources: { skills: ['*'], commands: ['*'] } }), agentDoc()), [])
  })

  it('env: variável nova ou alterada amplia; removida não', () => {
    const widenings = wideningsOf(agentDoc(), agentDoc({ env: { LANG: 'en_US.UTF-8', GIT_SSH_COMMAND: 'ssh -i x' } }))
    assert.deepStrictEqual(
      widenings.map((item) => item.category),
      ['environment', 'environment'],
    )
    assert.ok(widenings.some((item) => item.key.startsWith('agent/theo@alfa#env+GIT_SSH_COMMAND=h:')))
    assert.ok(widenings.some((item) => item.key.startsWith('agent/theo@alfa#env~LANG=h:')))
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ env: {} })), [])
  })

  it('triggers: novo ou com o "quando" alterado amplia; corpo alterado ou removido não', () => {
    const keys = keysOf(
      agentDoc(),
      agentDoc({
        triggers: [
          { id: 'deploy', when: 'Sempre', body: 'Rode o deploy.' },
          { id: 'abrir-pr', when: 'Ao abrir PR', body: 'Abra.' },
        ],
      }),
    )
    assert.strictEqual(keys.length, 2)
    assert.ok(keys.includes('agent/theo@alfa#triggers+abrir-pr'))
    assert.ok(keys.some((key) => key.startsWith('agent/theo@alfa#triggers~deploy=h:')))
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ triggers: [{ id: 'deploy', when: 'Ao subir', body: 'Outro corpo.' }] })), [])
    assert.deepStrictEqual(keysOf(agentDoc(), agentDoc({ triggers: [] })), [])
  })
})

describe('Catalog.Widening — item novo e apagado', () => {
  it('agente novo: tudo o que ele concede é ampliação', () => {
    const widenings = wideningsOf(undefined, agentDoc({ providers: [{ provider: 'claude', models: ['opus'], network: true }] }))
    assert.deepStrictEqual(wideningKeys(widenings), [
      'agent/theo@alfa#allowedTools+cap:files.read',
      'agent/theo@alfa#allowedTools+mcp:gh/list_issues',
      'agent/theo@alfa#env+LANG=h:' + widenings.find((item) => item.key.includes('#env+'))!.key.split('=h:')[1],
      'agent/theo@alfa#permissions+allow:terminal:git *',
      'agent/theo@alfa#providers.claude.network+',
      'agent/theo@alfa#resources.skills+revisar',
    ])
    // Triggers e lane são conteúdo do agente novo; adminOnly e subagent só fecham.
    assert.ok(!widenings.some((item) => item.category === 'trigger' || item.category === 'exposure'))
  })

  it('agente novo sem acesso nenhum → nada', () => {
    assert.deepStrictEqual(keysOf(undefined, agentDoc({ allowedTools: [], permissions: [], env: undefined }, { resources: { skills: [], commands: [] } })), [])
  })

  it('item apagado nunca amplia (agente, MCP)', () => {
    assert.deepStrictEqual(keysOf(agentDoc(), undefined), [])
    assert.deepStrictEqual(keysOf(mcpDoc({ identity: true }), undefined), [])
    assert.deepStrictEqual(keysOf(undefined, undefined), [])
  })

  it('⛔ apagar as permissões do projeto amplia: as negações saem', () => {
    assert.deepStrictEqual(keysOf(projectDoc(['read', 'secrets/**', 'deny'], ['terminal', 'git *', 'allow']), undefined), ['project-permissions/alfa#rules-deny:read:secrets/**'])
  })

  it('skill, command e rule nunca ampliam (só atenção)', () => {
    const skill = resourceDocument({ id: 'revisar', kind: 'skill', description: 'x', body: 'y', docIds: [], createdAt: at, updatedAt: at })
    assert.deepStrictEqual(keysOf(undefined, skill), [])
    assert.deepStrictEqual(keysOf(skill, resourceDocument({ id: 'revisar', kind: 'skill', description: 'x', body: 'z', docIds: ['a'], createdAt: at, updatedAt: at })), [])
    const rule = ruleDocument({ id: 'r', position: 1, title: 't', body: 'b', enabled: true, createdAt: at, updatedAt: at })
    assert.deepStrictEqual(keysOf(rule, undefined), [])
  })

  it('itens diferentes não se comparam', () => {
    assert.throws(() => wideningsOf(agentDoc(), agentDoc({ id: 'maya' })), /not the same item/)
  })
})

describe('Catalog.Widening — permissões do projeto', () => {
  it('allow novo ou alterado amplia; deny removido amplia; deny novo e reordenar não', () => {
    const before = projectDoc(['terminal', 'npm test', 'allow'], ['write', 'dist/**', 'deny'])
    assert.deepStrictEqual(keysOf(before, projectDoc(['terminal', 'npm *', 'allow'], ['write', 'dist/**', 'deny'])), ['project-permissions/alfa#rules+allow:terminal:npm *'])
    assert.deepStrictEqual(keysOf(before, projectDoc(['terminal', 'npm test', 'allow'])), ['project-permissions/alfa#rules-deny:write:dist/**'])
    assert.deepStrictEqual(keysOf(before, projectDoc(['write', 'dist/**', 'deny'], ['terminal', 'npm test', 'allow'], ['read', '**', 'deny'])), [])
  })

  it('projeto novo: cada allow amplia (inclusive o skill * do opencode global)', () => {
    assert.deepStrictEqual(keysOf(undefined, projectDoc(['skill', '*', 'allow'], ['read', 'secrets/**', 'deny'])), ['project-permissions/alfa#rules+allow:skill:*'])
  })
})

describe('Catalog.Widening — MCP', () => {
  it('MCP novo amplia, com o que ele alcança; global é ampliação à parte', () => {
    const widenings = wideningsOf(undefined, mcpDoc({ projectId: undefined, identity: true, auth: 'caller' }))
    assert.deepStrictEqual(
      widenings.map((item) => [item.category, item.key]),
      [
        ['mcp-reach', 'mcp/n8n#auth~caller'],
        ['mcp-reach', 'mcp/n8n#container.writable+/tmp'],
        ['identity', 'mcp/n8n#identity+'],
        ['mcp-reach', 'mcp/n8n#new~container:n8n/mcp:1'],
        ['scope', 'mcp/n8n#projectId-'],
      ],
    )
    assert.deepStrictEqual(keysOf(undefined, mcpDoc()), ['mcp/n8n@alfa#container.writable+/tmp', 'mcp/n8n@alfa#new~container:n8n/mcp:1'])
  })

  it('ligar, trocar imagem/url/kind/args, e auth fora de none ampliam; desligar e auth → none não', () => {
    assert.deepStrictEqual(keysOf(mcpDoc({ enabled: false }), mcpDoc()), ['mcp/n8n@alfa#enabled+'])
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc({ enabled: false })), [])
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc(container({ image: 'n8n/mcp:2' }))), ['mcp/n8n@alfa#container.image~n8n/mcp:2'])
    assert.strictEqual(keysOf(mcpDoc(), mcpDoc(container({ args: ['--all'] })))[0].startsWith('mcp/n8n@alfa#container.args~h:'), true)
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc({ kind: 'process', container: undefined, process: { command: 'npx', args: [], env: [], scope: 'conversation' } })), [
      'mcp/n8n@alfa#kind~process',
      'mcp/n8n@alfa#process.command~npx',
    ])
    const remote = { kind: 'remote' as const, container: undefined, url: 'https://a.example/mcp' }
    assert.deepStrictEqual(keysOf(mcpDoc(remote), mcpDoc({ ...remote, url: 'https://b.example/mcp' })), ['mcp/n8n@alfa#url~https://b.example/mcp'])
    assert.deepStrictEqual(keysOf(mcpDoc({ auth: 'header' }), mcpDoc({ auth: 'caller' })), ['mcp/n8n@alfa#auth~caller'])
    assert.deepStrictEqual(keysOf(mcpDoc({ auth: 'caller' }), mcpDoc({ auth: 'none' })), [])
  })

  it('rede none → allowlist, domínio e caminho gravável novos ampliam; tirar não', () => {
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc(container({ network: 'allowlist', allowedHosts: ['api.x.com'], writable: ['/tmp', '/data'] }))), [
      'mcp/n8n@alfa#container.allowedHosts+api.x.com',
      'mcp/n8n@alfa#container.network~allowlist',
      'mcp/n8n@alfa#container.writable+/data',
    ])
    assert.deepStrictEqual(keysOf(mcpDoc(container({ network: 'allowlist', allowedHosts: ['a.com', 'b.com'] })), mcpDoc(container({ network: 'none', writable: [] }))), [])
  })

  it('processo compartilhado amplia; por conversa não', () => {
    const proc = (scope: 'conversation' | 'shared') => mcpDoc({ kind: 'process', container: undefined, process: { package: '@x/mcp@1', args: [], env: [], scope } })
    assert.deepStrictEqual(keysOf(proc('conversation'), proc('shared')), ['mcp/n8n@alfa#process.scope~shared'])
    assert.deepStrictEqual(keysOf(proc('shared'), proc('conversation')), [])
  })

  it('identidade ligada amplia; desligada não', () => {
    assert.deepStrictEqual(
      wideningsOf(mcpDoc(), mcpDoc({ identity: true })).map((item) => [item.category, item.key]),
      [['identity', 'mcp/n8n@alfa#identity+']],
    )
    assert.deepStrictEqual(keysOf(mcpDoc({ identity: true }), mcpDoc()), [])
  })

  it('projeto → global amplia; projeto → outro amplia; global → projeto não', () => {
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc({ projectId: undefined })), ['mcp/n8n#projectId-'])
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc({ projectId: 'beta' })), ['mcp/n8n@beta#projectId~beta'])
    assert.deepStrictEqual(keysOf(mcpDoc({ projectId: undefined }), mcpDoc()), [])
  })

  it('nome, transporte, memória e nomes de segredo não ampliam', () => {
    assert.deepStrictEqual(keysOf(mcpDoc(), mcpDoc({ name: 'N8N', transport: 'http', ...container({ memoryMb: 2048, env: ['API'] }) })), [])
  })
})

describe('Catalog.Widening — chave estável', () => {
  const before = agentDoc()
  const after = agentDoc({
    allowedTools: ['cap:terminal', 'agent:maya', 'mcp:gh/*'],
    adminOnly: false,
    permissions: rules(['terminal', 'npm *', 'allow'], ['write', 'src/**', 'allow']),
  })

  it('mesma entrada → mesmas chaves e mesma saída', () => {
    assert.deepStrictEqual(wideningsOf(before, after), wideningsOf(structuredClone(before), structuredClone(after)))
  })

  it('a ordem das listas não importa', () => {
    const shuffled = agentDoc({
      allowedTools: ['mcp:gh/*', 'agent:maya', 'cap:terminal'],
      adminOnly: false,
      permissions: rules(['write', 'src/**', 'allow'], ['terminal', 'npm *', 'allow']),
    })
    assert.deepStrictEqual(wideningsOf(before, shuffled), wideningsOf(before, after))
  })

  it('a saída sai ordenada pela chave, sem repetição', () => {
    const widenings = wideningsOf(before, agentDoc({ permissions: rules(['terminal', 'npm *', 'allow'], ['terminal', 'npm *', 'allow']) }))
    assert.deepStrictEqual(
      widenings.map((item) => item.key),
      ['agent/theo@alfa#permissions+allow:terminal:npm *', 'agent/theo@alfa#permissions-deny:read:**/.env'],
    )
  })

  it('confirm bate só com o conjunto exato (ordem e repetição não contam)', () => {
    const widenings: IWidening[] = wideningsOf(before, after)
    const keys = wideningKeys(widenings)
    assert.ok(confirmsWidenings([...keys].reverse(), widenings))
    assert.ok(confirmsWidenings([...keys, keys[0]], widenings))
    assert.ok(!confirmsWidenings(keys.slice(1), widenings))
    assert.ok(!confirmsWidenings([...keys, 'agent/theo@alfa#allowedTools+cap:extra'], widenings))
    assert.ok(confirmsWidenings([], []))
  })

  it('descrição em pt-BR, com o item', () => {
    const [first] = wideningsOf(agentDoc(), agentDoc({ adminOnly: false }))
    assert.strictEqual(first.description, 'Agente theo (projeto alfa): deixa de ser só para admin: qualquer pessoa conversa com ele')
    assert.deepStrictEqual([first.kind, first.id, first.projectId, first.category], ['agent', 'theo', 'alfa', 'exposure'])
  })
})

describe('Catalog.Widening — comparar globs (patternCovers)', () => {
  const cases: Array<[TPermissionCategory, string, string, boolean, string]> = [
    // Igual.
    ['terminal', 'git *', ' git * ', true, 'igual (aparado)'],
    ['read', 'src/**', 'src/**', true, 'igual'],
    // Mais amplo cobre o mais estreito.
    ['terminal', '*', 'rm -rf build', true, 'curinga total'],
    ['terminal', 'git *', 'git push origin *', true, 'prefixo de palavras'],
    ['terminal', 'git push *', 'git push', true, '* casa nenhuma palavra'],
    ['terminal', 'npm run test*', 'npm run test:unit', true, 'literal casado pelo largo'],
    ['read', '**', 'apps/x/**', true, '** sem barra cobre todo relativo'],
    ['read', '*', '**/.env', true, '* sem barra casa o nome em qualquer pasta'],
    ['read', 'src/**', 'src/a/*.ts', true, 'prefixo de pasta'],
    ['read', 'src/**', 'src/a.ts', true, 'literal sob a pasta'],
    ['read', 'src/**', 'src', false, 'sem barra, o estreito casa "src" em qualquer pasta'],
    ['read', '*.ts', 'index.ts', true, 'nome casado pelo nome'],
    ['write', '/srv/app/**', '/srv/app/logs/*', true, 'absoluto sob absoluto'],
    ['network', '*', 'api.github.com:443', true, 'qualquer host'],
    ['network', '*.github.com', 'api.github.com', true, 'subdomínio literal'],
    ['network', '*.x.com', '*.a.x.com', true, 'subdomínio de subdomínio'],
    ['network', '*.x.com', 'h.x.com:22', true, 'sem porta cobre com porta'],
    ['skill', 'akm-*', 'akm-review*', true, 'prefixo de texto'],
    ['skill', '*', 'qualquer', true, 'curinga total de texto'],
    ['mcp', 'gh/*', 'gh/list_issues', true, 'ferramenta do servidor'],
    // Mais estreito NÃO cobre o mais amplo.
    ['terminal', 'git push *', 'git *', false, 'mais estreito'],
    ['read', 'src/**', '**', false, 'mais estreito'],
    ['network', 'api.github.com', '*.github.com', false, 'mais estreito'],
    ['network', 'h.x.com:22', 'h.x.com', false, 'com porta não cobre sem porta'],
    ['skill', 'akm-x*', 'akm-*', false, 'mais estreito'],
    // Incomparável (não dá para provar) → false → ampliação.
    ['terminal', 'git * --dry-run', 'git push --dry-run *', false, 'curinga no meio'],
    ['terminal', 'git *', '/usr/bin/git status', false, 'nome com caminho'],
    ['read', 'src/**', '*.ts', false, 'o estreito casa em qualquer pasta'],
    ['read', 'src/*', 'src/a*', false, 'curinga de um nível'],
    ['read', '**/*.ts', 'src/**/*.ts', false, 'curinga no começo'],
    ['read', '**', '/etc/hosts', false, 'relativo não cobre absoluto'],
    ['read', '/srv/**', 'srv/x', false, 'absoluto não cobre relativo'],
    ['network', '*.x.com', '*', false, 'estreito é tudo'],
    ['skill', '*-review', 'akm-*', false, 'curinga no começo'],
    ['skill', 'a*b', 'a*', false, 'curinga no meio'],
  ]
  for (const [category, wide, narrow, expected, why] of cases)
    it(`${category}: "${wide}" ${expected ? 'cobre' : 'não cobre'} "${narrow}" (${why})`, () => assert.strictEqual(patternCovers(category, wide, narrow), expected))
})
