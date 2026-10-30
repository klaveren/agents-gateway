import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  AGENT_LINKS_SHAPE,
  AGENT_RESOURCES_SHAPE,
  AGENT_SHAPE,
  agentDocument,
  canonicalize,
  DIAGNOSTICS_SHAPE,
  DOC_SHAPE,
  docDocument,
  FALLBACK_SHAPE,
  FALLBACK_STEP_SHAPE,
  IAgentLinks,
  MCP_CONTAINER_SHAPE,
  MCP_PROCESS_SHAPE,
  MCP_SHAPE,
  mcpDocument,
  parseProtocolItemId,
  PERMISSION_RULE_SHAPE,
  PROJECT_SHAPE,
  projectDocument,
  projectPermissionsDocument,
  PROTOCOL_SHAPE,
  protocolDocument,
  protocolItemId,
  RESOURCE_SHAPE,
  resourceDocument,
  RULE_SHAPE,
  ruleDocument,
  TARGET_SHAPE,
  TERMINAL_SHAPE,
  TRIGGER_SHAPE,
} from './Catalog.Document'
import { EMode } from './enums/EMode.Enum'
import { IAgent } from './models/Agent.Model'
import { IMcpServerConfig } from './models/McpServer.Model'
import { IResource } from './models/Resource.Model'

/**
 * Os campos de uma interface, lidos do FONTE (o `tsx` não checa tipo, então o teste não pode depender do `tsc`): as
 * linhas `  campo:` / `  campo?:` no primeiro nível do corpo. O prettier do repositório garante a forma.
 */
function interfaceFields(file: string, name: string): string[] {
  const source = readFileSync(path.join(__dirname, file), 'utf8')
  const start = source.search(new RegExp(`^export interface ${name}\\b[^{]*\\{`, 'm'))
  assert.ok(start >= 0, `interface ${name} não achada em ${file}`)
  const fields: string[] = []
  for (const line of source.slice(start).split('\n').slice(1)) {
    if (line.startsWith('}')) break
    const match = /^ {2}(\w+)\??:/.exec(line)
    if (match) fields.push(match[1])
  }
  return fields.sort()
}

const keys = (shape: object) => Object.keys(shape).sort()

describe('Catalog.Document — exaustividade dos campos', () => {
  const cases: Array<[string, string, object]> = [
    ['models/Agent.Model.ts', 'IAgent', AGENT_SHAPE],
    ['models/Agent.Model.ts', 'IAgentTarget', TARGET_SHAPE],
    ['models/Agent.Model.ts', 'IAgentTerminal', TERMINAL_SHAPE],
    ['models/Agent.Model.ts', 'IAgentDiagnostics', DIAGNOSTICS_SHAPE],
    ['models/Agent.Model.ts', 'IAgentTrigger', TRIGGER_SHAPE],
    ['Fallback.Policy.ts', 'IAgentFallback', FALLBACK_SHAPE],
    ['Fallback.Policy.ts', 'IFallbackStep', FALLBACK_STEP_SHAPE],
    ['Permission.Policy.ts', 'IPermissionRule', PERMISSION_RULE_SHAPE],
    ['Catalog.Document.ts', 'IAgentLinks', AGENT_LINKS_SHAPE],
    ['models/Resource.Model.ts', 'IAgentResources', AGENT_RESOURCES_SHAPE],
    ['models/Resource.Model.ts', 'IResource', RESOURCE_SHAPE],
    ['models/Rule.Model.ts', 'IRule', RULE_SHAPE],
    ['models/ProjectDoc.Model.ts', 'IProjectDoc', DOC_SHAPE],
    ['models/Protocol.Model.ts', 'IProtocolAddendum', PROTOCOL_SHAPE],
    ['models/Project.Model.ts', 'IProject', PROJECT_SHAPE],
    ['models/McpServer.Model.ts', 'IMcpServerConfig', MCP_SHAPE],
    ['models/McpServer.Model.ts', 'IMcpContainer', MCP_CONTAINER_SHAPE],
    ['models/McpServer.Model.ts', 'IMcpProcess', MCP_PROCESS_SHAPE],
  ]

  for (const [file, name, shape] of cases) {
    it(`⛔ todo campo de ${name} está classificado (entra ou fica fora, com motivo)`, () => {
      assert.deepStrictEqual(
        keys(shape),
        interfaceFields(file, name),
        `${name} ganhou ou perdeu campo: classifique-o em Catalog.Document (entra no documento canônico ou fica fora, e por quê)`,
      )
    })
  }

  it('o leitor de interface acha os campos opcionais e ignora os comentários', () => {
    assert.ok(interfaceFields('models/Agent.Model.ts', 'IAgent').includes('env'))
    assert.ok(!interfaceFields('models/Agent.Model.ts', 'IAgent').includes('Onde'))
  })
})

const at = new Date('2026-10-30T12:00:00.000Z')

/** Um agente com TODOS os campos (o `Required` obriga a preencher também os que nascerem depois). */
const fullAgent: Required<IAgent> = {
  id: 'theo',
  name: 'Theo',
  providers: [
    { provider: 'claude', models: ['opus', 'sonnet'], sandbox: 'workspace-write', network: true },
    { provider: 'openai', models: ['gpt'] },
  ],
  soul: 'Calmo.',
  systemPrompt: 'Faça X.',
  reasoningEfforts: ['low', 'high'],
  modes: [EMode.CHAT, EMode.AGENT],
  allowedTools: ['cap:terminal', 'cap:files.read', 'mcp:gh/*'],
  role: 'subagent',
  adminOnly: true,
  projectId: 'alfa',
  permissions: [
    { category: 'terminal', pattern: 'git *', decision: 'allow' },
    { category: 'read', pattern: 'docs/**', decision: 'deny', note: 'não' },
  ],
  terminal: { timeoutSeconds: 60, maxOutputChars: 5000 },
  diagnostics: { typecheck: true, lint: false, format: true, timeoutSeconds: 30 },
  triggers: [
    { id: 'deploy', when: 'Ao subir', body: 'Rode o deploy.' },
    { id: 'abrir-pr', when: 'Ao abrir PR', body: 'Abra o PR.' },
  ],
  fallback: { mode: 'own', chain: [{ provider: 'openai', model: 'gpt' }] },
  env: { GIT_AUTHOR_NAME: 'Theo', LANG: 'pt_BR.UTF-8' },
}
const links: IAgentLinks = { resources: { skills: ['revisar', 'commitar'], commands: ['*'] }, initialContext: ['visao', 'api'] }

/** Reconstrói o objeto com as chaves na ordem inversa, em todos os níveis (mesmo conteúdo, outra ordem). */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversedKeys(item)]),
    ) as T
  return value
}

describe('Catalog.Document — forma estável', () => {
  it('mesma entrada → mesmo texto e mesmo hash', () => {
    const a = agentDocument(fullAgent, links)
    const b = agentDocument(structuredClone(fullAgent), structuredClone(links))
    assert.strictEqual(a.text, b.text)
    assert.strictEqual(a.hash, b.hash)
    assert.match(a.hash, /^[0-9a-f]{64}$/)
  })

  it('chaves em outra ordem e conjuntos em outra ordem → o mesmo documento', () => {
    const shuffled: IAgent = {
      ...reversedKeys(fullAgent),
      modes: [...fullAgent.modes].reverse(),
      allowedTools: [...fullAgent.allowedTools].reverse(),
    }
    const shuffledLinks: IAgentLinks = { initialContext: links.initialContext, resources: { commands: ['*'], skills: [...links.resources.skills].reverse() } }
    assert.strictEqual(agentDocument(shuffled, shuffledLinks).text, agentDocument(fullAgent, links).text)
  })

  it('⚖️ lista em que a ordem importa continua na ordem (providers, modelos, triggers, permissões, contexto)', () => {
    const base = agentDocument(fullAgent, links).hash
    const swap = <T>(items: T[]) => [...items].reverse()
    assert.notStrictEqual(agentDocument({ ...fullAgent, providers: swap(fullAgent.providers) }, links).hash, base)
    assert.notStrictEqual(agentDocument({ ...fullAgent, providers: [{ ...fullAgent.providers[0], models: ['sonnet', 'opus'] }, fullAgent.providers[1]] }, links).hash, base)
    assert.notStrictEqual(agentDocument({ ...fullAgent, triggers: swap(fullAgent.triggers) }, links).hash, base)
    assert.notStrictEqual(agentDocument({ ...fullAgent, permissions: swap(fullAgent.permissions) }, links).hash, base)
    assert.notStrictEqual(agentDocument(fullAgent, { ...links, initialContext: swap(links.initialContext) }).hash, base)
  })

  it('texto: chaves ordenadas, indentação de 2, LF e quebra no fim', () => {
    const { text, body } = agentDocument(fullAgent, links)
    assert.ok(text.endsWith('}\n'))
    assert.ok(!text.includes('\r'))
    assert.ok(text.startsWith('{\n  "adminOnly": true,\n'))
    assert.deepStrictEqual(Object.keys(JSON.parse(text)), Object.keys(body).sort())
    assert.strictEqual(canonicalize(body), text)
  })

  it('ausentes omitidos: undefined e null não viram chave; lista vazia fica (`[]` de recursos = nenhum)', () => {
    const minimal: IAgent = { id: 'min', name: 'Min', providers: [{ provider: 'claude', models: ['opus'] }], systemPrompt: 'P', modes: [EMode.CHAT], allowedTools: [] }
    const body = agentDocument({ ...minimal, soul: undefined, projectId: null as unknown as string }, { resources: { skills: [], commands: ['*'] }, initialContext: [] }).body
    assert.deepStrictEqual(Object.keys(body).sort(), ['allowedTools', 'id', 'initialContext', 'modes', 'name', 'providers', 'resources', 'systemPrompt'])
    assert.deepStrictEqual(body.resources, { commands: ['*'], skills: [] })
  })
})

describe('Catalog.Document — conteúdo, metadado e vínculos', () => {
  const resource: IResource = {
    id: 'revisar',
    kind: 'skill',
    projectId: 'alfa',
    description: 'Revisa',
    body: '# Passos',
    docIds: ['b', 'a'],
    docRefs: ['b', 'a'],
    createdAt: at,
    updatedAt: at,
    updatedBy: 'ana',
  }

  it('createdAt, updatedAt e updatedBy ficam fora: regravar sem mudar conteúdo não muda o hash', () => {
    const before = resourceDocument(resource)
    const after = resourceDocument({ ...resource, updatedAt: new Date(), updatedBy: 'bruno', createdAt: new Date(0) })
    assert.strictEqual(after.hash, before.hash)
    assert.ok(!/createdAt|updatedAt|updatedBy|bruno|ana/.test(before.text))
  })

  it('a skill leva os docs anexados: docIds na ordem, docRefs ordenado', () => {
    const doc = resourceDocument(resource)
    assert.deepStrictEqual([doc.kind, doc.id, doc.projectId], ['skill', 'revisar', 'alfa'])
    assert.deepStrictEqual(doc.body, { id: 'revisar', projectId: 'alfa', description: 'Revisa', body: '# Passos', docIds: ['b', 'a'], docRefs: ['a', 'b'] })
  })

  it('o agente leva os recursos e o contexto inicial; o projeto, o contexto inicial', () => {
    const agent = agentDocument(fullAgent, links).body
    assert.deepStrictEqual(agent.resources, { skills: ['commitar', 'revisar'], commands: ['*'] })
    assert.deepStrictEqual(agent.initialContext, ['visao', 'api'])
    const project = projectDocument({ id: 'alfa', name: 'Alfa', description: 'D', createdAt: at, updatedAt: at, updatedBy: 'ana' }, ['visao', 'api'])
    assert.deepStrictEqual([project.kind, project.id, project.projectId], ['project', 'alfa', 'alfa'])
    assert.deepStrictEqual(project.body, { id: 'alfa', name: 'Alfa', description: 'D', initialContext: ['visao', 'api'] })
  })

  it('rule, doc, complemento e permissões do projeto', () => {
    const rule = ruleDocument({ id: 'u-1', position: 2, title: 'T', body: 'B', enabled: false, createdAt: at, updatedAt: at })
    assert.deepStrictEqual([rule.kind, rule.projectId, rule.body], ['rule', undefined, { id: 'u-1', position: 2, title: 'T', body: 'B', enabled: false }])
    const doc = docDocument({ id: 'api', kind: 'adr', title: 'API', summary: 'S', body: 'X', createdAt: at, updatedAt: at })
    assert.deepStrictEqual([doc.kind, doc.body], ['adr', { id: 'api', title: 'API', summary: 'S', body: 'X' }])
    const addendum = protocolDocument({ kind: 'skill', projectId: 'alfa', body: 'Mais', updatedAt: at, updatedBy: 'ana' })
    assert.deepStrictEqual([addendum.id, addendum.projectId, addendum.body], ['alfa/skill', 'alfa', { kind: 'skill', projectId: 'alfa', body: 'Mais' }])
    const permissions = projectPermissionsDocument('alfa', [{ category: 'write', pattern: '**', decision: 'allow' }])
    assert.deepStrictEqual(permissions.body, { projectId: 'alfa', rules: [{ category: 'write', pattern: '**', decision: 'allow' }] })
  })

  it('o id do complemento vai e volta; tipo desconhecido não é complemento', () => {
    assert.deepStrictEqual(parseProtocolItemId(protocolItemId('rule')), { kind: 'rule' })
    assert.deepStrictEqual(parseProtocolItemId(protocolItemId('agent', 'alfa')), { kind: 'agent', projectId: 'alfa' })
    assert.strictEqual(parseProtocolItemId('alfa/nada'), undefined)
    assert.strictEqual(parseProtocolItemId('/skill'), undefined)
  })
})

describe('Catalog.Document — ⛔ segredo nunca entra', () => {
  const server: IMcpServerConfig = {
    id: 'gh',
    name: 'GitHub',
    kind: 'container',
    container: {
      image: 'ghcr.io/x/gh:1',
      args: ['--stdio'],
      writable: ['/tmp'],
      memoryMb: 512,
      cpus: 1,
      network: 'allowlist',
      allowedHosts: ['github.com', 'api.github.com'],
      env: ['GH_TOKEN', 'B_KEY'],
    },
    url: '',
    transport: 'auto',
    auth: 'header',
    headerName: 'X-Api-Key',
    identity: true,
    enabled: true,
    createdAt: at,
    updatedAt: at,
    updatedBy: 'ana',
  }

  it('MCP: só os NOMES das variáveis e do header, e a lista do que o cofre precisa ter', () => {
    const doc = mcpDocument(server)
    assert.strictEqual(doc.projectId, undefined)
    assert.deepStrictEqual(doc.body.secrets, ['env:B_KEY', 'env:GH_TOKEN', 'header'])
    assert.deepStrictEqual((doc.body.container as Record<string, unknown>).env, ['B_KEY', 'GH_TOKEN'])
    assert.deepStrictEqual((doc.body.container as Record<string, unknown>).allowedHosts, ['api.github.com', 'github.com'])
    assert.strictEqual(doc.body.headerName, 'X-Api-Key')
  })

  it('campo fora da lista não sai, em nenhum nível (valor do cofre colado no objeto, chave de API no provider)', () => {
    const SECRET = 'sk-ant-api03-SEGREDO-que-nao-pode-sair'
    const leakyServer = {
      ...server,
      headerValue: SECRET,
      secret: SECRET,
      container: { ...server.container!, envValues: { GH_TOKEN: SECRET } },
      process: { args: [], env: ['X'], scope: 'shared' as const, token: SECRET },
    } as unknown as IMcpServerConfig
    const leakyAgent = {
      ...fullAgent,
      apiKey: SECRET,
      providers: [{ ...fullAgent.providers[0], apiKey: SECRET }],
      terminal: { ...fullAgent.terminal, password: SECRET },
      fallback: { mode: 'own', chain: [{ provider: 'openai', model: 'gpt', credential: SECRET }] },
      permissions: [{ ...fullAgent.permissions[0], token: SECRET }],
      triggers: [{ ...fullAgent.triggers[0], secret: SECRET }],
    } as unknown as IAgent
    for (const doc of [mcpDocument(leakyServer), agentDocument(leakyAgent, links)]) {
      assert.ok(!doc.text.includes(SECRET), `${doc.kind}/${doc.id} vazou um campo fora da lista`)
      assert.ok(!/apiKey|headerValue|envValues|password|credential|"token"|"secret"/.test(doc.text))
    }
  })

  it('MCP de processo e remoto: sem header, `secrets` só com as variáveis (ou vazio)', () => {
    const process = mcpDocument({ ...server, kind: 'process', container: undefined, process: { args: [], env: ['Z'], scope: 'conversation' }, auth: 'caller' })
    assert.deepStrictEqual(process.body.secrets, ['env:Z'])
    const remote = mcpDocument({ ...server, kind: 'remote', container: undefined, url: 'https://mcp.example.com/', auth: 'none', headerName: undefined })
    assert.deepStrictEqual(remote.body.secrets, [])
  })
})
