import assert from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { AGENT_LINKS_SHAPE, AGENT_SHAPE, MCP_SHAPE, PROJECT_SHAPE } from '@domain/Catalog.Document'
import { documentsFromFiles, MANIFEST_PATH } from '@domain/Catalog.Files'
import { ProjectNotFoundError } from '@domain/errors/Domain.Error'
import { EMode } from '@domain/enums/EMode.Enum'
import { parseFrontmatter } from '@domain/Frontmatter.Codec'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SecretMasker } from '@infra/secrets/Secret.Masker'
import { CatalogReader } from './Catalog.Reader'
import { CatalogExportUseCase } from './CatalogExport.Usecase'

const at = new Date('2026-10-30T12:00:00.000Z')
/** Segredos de mentira, com a forma dos de verdade. */
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`
const KNOWN = 'senha-cadastrada-na-tela-123'
const OPAQUE = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2'
const API_KEY = `sk-ant-api03-${'x'.repeat(30)}`

/** Um gateway com dois projetos, itens globais e de projeto, e segredos colados onde o PR 1 apontou risco. */
function build() {
  const deps = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const { agents, guidance, permissions, mcps, projects } = deps
  projects.insert({ id: 'alfa', name: 'Alfa', description: 'Projeto alfa', createdAt: at, updatedAt: at })
  projects.insert({ id: 'beta', name: 'Beta', createdAt: at, updatedAt: at })
  for (const projectId of ['alfa', 'beta', undefined]) {
    const scope = projectId ? { projectId } : {}
    const tag = projectId ?? 'g'
    guidance.insertDoc({ id: `spec-${tag}`, kind: 'spec', ...scope, title: `Spec ${tag}`, summary: 'S', body: 'B', createdAt: at, updatedAt: at })
    guidance.insertDoc({ id: `adr-${tag}`, kind: 'adr', ...scope, title: `ADR ${tag}`, summary: 'S', body: 'B', createdAt: at, updatedAt: at })
    guidance.insertDoc({ id: `kn-${tag}`, kind: 'knowledge', ...scope, title: `K ${tag}`, summary: 'S', body: 'B', createdAt: at, updatedAt: at })
    guidance.saveResource({ id: `skill-${tag}`, kind: 'skill', ...scope, description: 'D', body: 'B', docIds: [`spec-${tag}`], createdAt: at, updatedAt: at })
    guidance.saveResource({ id: `cmd-${tag}`, kind: 'command', ...scope, description: 'D', body: '$ARGUMENTS', docIds: [], createdAt: at, updatedAt: at })
    guidance.insertRule({ id: `rule-${tag}`, ...scope, position: 1, title: `Regra ${tag}`, body: 'B', enabled: true, createdAt: at, updatedAt: at })
    guidance.setProtocolAddendum('skill', projectId ?? null, { kind: 'skill', ...scope, body: `Mais ${tag}`, updatedAt: at })
    const agent: IAgent = {
      id: `agente-${tag}`,
      name: 'A',
      providers: [{ provider: 'claude', models: ['opus'] }],
      soul: 'Calmo.',
      systemPrompt: `Prompt de ${tag}`,
      modes: [EMode.AGENT],
      allowedTools: ['cap:terminal'],
      ...scope,
    }
    // ⛔ Um campo a mais no JSON gravado (um segredo velho) não sai: a forma é lista de permitidos.
    agents.save({ ...agent, apiKey: API_KEY } as IAgent, 'ana')
    mcps.insert({ id: `mcp-${tag}`, name: 'M', url: `https://mcp.${tag}.example.com/`, transport: 'auto', auth: 'none', enabled: true, ...scope, createdAt: at, updatedAt: at })
  }
  permissions.saveProjectRules('alfa', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }], 'ana')

  // Os riscos: segredo no corpo de uma skill, no env e no prompt do agente, na url e nos args do MCP.
  guidance.saveResource({
    id: 'deploy',
    kind: 'skill',
    projectId: 'alfa',
    description: 'Deploy',
    body: `Use o token ${GH}\nAPI_TOKEN=${OPAQUE}\nA senha é ${KNOWN}.\n`,
    docIds: [],
    createdAt: at,
    updatedAt: at,
  })
  agents.save(
    {
      id: 'vazador',
      name: 'V',
      providers: [{ provider: 'claude', models: ['opus'] }],
      systemPrompt: `Chame com ${API_KEY}`,
      modes: [EMode.AGENT],
      allowedTools: [],
      projectId: 'alfa',
      env: { GIT_AUTHOR_NAME: 'Bot da Silva', GH_TOKEN: OPAQUE, HOST: 'api.example.com' },
    },
    'ana',
  )
  mcps.insert({
    id: 'banco',
    name: 'Banco',
    kind: 'process',
    process: {
      command: 'npx',
      args: ['-y', 'pg-mcp', '--password', OPAQUE, `--api-key=${OPAQUE}`, '--port', '5432', `postgres://app:${KNOWN}@db:5432/app`],
      env: ['PGPASSWORD'],
      scope: 'shared',
    },
    url: `https://user:pw-${OPAQUE}@n8n.example.com/mcp?access_token=${OPAQUE}&region=sa-east-1`,
    transport: 'auto',
    auth: 'header',
    headerName: 'Authorization',
    enabled: true,
    projectId: 'alfa',
    createdAt: at,
    updatedAt: at,
  })

  const masker = new SecretMasker(new SecretBox(randomBytes(32)))
  masker.saveValue('banco', 'senha do banco', KNOWN, 'ana')
  const exporter = new CatalogExportUseCase({ reader: new CatalogReader(deps), mask: masker, version: '1.2.3', now: () => at })
  return { exporter, masker }
}

const paths = (files: Record<string, string>) => Object.keys(files).sort()

describe('CatalogExportUseCase — escopos', () => {
  const { exporter } = build()

  it('all: global e todos os projetos, cada um na sua pasta, mais o manifesto', () => {
    const { files, manifest } = exporter.run({ kind: 'all' }, 'root@x.test')
    const all = paths(files)
    assert.ok(all.includes(MANIFEST_PATH))
    for (const root of ['global', 'projects/alfa', 'projects/beta']) {
      for (const dir of ['specs', 'adrs', 'knowledge', 'skills', 'commands', 'rules', 'protocols', 'agents', 'mcps']) {
        assert.ok(
          all.some((path) => path.startsWith(`${root}/${dir}/`)),
          `${root}/${dir}`,
        )
      }
    }
    assert.ok(all.includes('projects/alfa/project.json') && all.includes('projects/alfa/permissions.json') && all.includes('projects/beta/project.json'))
    assert.deepStrictEqual([manifest.format, manifest.scope, manifest.gateway, manifest.exportedAt, manifest.exportedBy], [1, 'all', '1.2.3', at.toISOString(), 'root@x.test'])
  })

  it('global: só o que não é de projeto (e os MCPs globais)', () => {
    const { files, manifest } = exporter.run({ kind: 'global' })
    assert.strictEqual(manifest.scope, 'global')
    assert.ok(paths(files).every((path) => path === MANIFEST_PATH || path.startsWith('global/')))
    assert.ok(files['global/mcps/mcp-g.json'])
  })

  it('⛔ projeto: só o projeto — nada global, nada de outro projeto', () => {
    const { files, manifest } = exporter.run({ kind: 'project', projectId: 'beta' })
    assert.strictEqual(manifest.scope, 'project:beta')
    assert.ok(paths(files).every((path) => path === MANIFEST_PATH || path.startsWith('projects/beta/')))
    assert.ok(!JSON.stringify(files).includes('alfa'))
    assert.ok(files['projects/beta/mcps/mcp-beta.json'] && files['projects/beta/agents/agente-beta/agent.json'])
  })

  it('projeto que não existe: ProjectNotFoundError (404), sem pacote vazio enganoso', () => {
    assert.throws(() => exporter.run({ kind: 'project', projectId: 'nada' }), ProjectNotFoundError)
  })

  it('cada tipo no formato: .md com frontmatter para texto, JSON para estrutura; e volta aos documentos', () => {
    const { files } = exporter.run({ kind: 'all' })
    const skill = parseFrontmatter(files['global/skills/skill-g/SKILL.md'])
    assert.deepStrictEqual(skill, { data: { name: 'skill-g', description: 'D', docs: ['spec-g'] }, body: 'B' })
    assert.deepStrictEqual(parseFrontmatter(files['projects/alfa/rules/regra-alfa.md']).data, { id: 'rule-alfa', title: 'Regra alfa', position: 1, enabled: true })
    assert.deepStrictEqual(parseFrontmatter(files['global/specs/spec-g.md']).data, { id: 'spec-g', title: 'Spec g', summary: 'S', docs: [] })
    assert.deepStrictEqual(parseFrontmatter(files['global/protocols/skill.md']), { data: { kind: 'skill' }, body: 'Mais g' })
    assert.strictEqual(JSON.parse(files['projects/alfa/permissions.json']).rules[0].pattern, 'git *')
    assert.strictEqual(files['global/agents/agente-g/soul.md'], 'Calmo.')
    const { errors } = documentsFromFiles(files)
    assert.deepStrictEqual(errors, [])
  })
})

describe('CatalogExportUseCase — ⛔ segredo nunca sai', () => {
  const { exporter, masker } = build()
  const { files, manifest } = exporter.run({ kind: 'all' })
  const everything = Object.values(files).join('\n')

  it('nenhum segredo, em arquivo nenhum (o manifesto incluso)', () => {
    for (const secret of [GH, KNOWN, OPAQUE, API_KEY]) assert.ok(!everything.includes(secret), secret.slice(0, 8))
  })

  it('o corpo da skill: formato de token, forma (`NOME=valor`) e valor conhecido', () => {
    const body = parseFrontmatter(files['projects/alfa/skills/deploy/SKILL.md']).body
    assert.strictEqual(body, 'Use o token [segredo:token do GitHub]\nAPI_TOKEN=[segredo:API_TOKEN]\nA senha é [segredo:senha do banco].\n')
  })

  it('o env do agente: o nome ancora a forma; o que não é segredo fica', () => {
    const agent = JSON.parse(files['projects/alfa/agents/vazador/agent.json'])
    assert.deepStrictEqual(agent.env, { GIT_AUTHOR_NAME: 'Bot da Silva', GH_TOKEN: '[segredo:GH_TOKEN]', HOST: 'api.example.com' })
    assert.strictEqual(files['projects/alfa/agents/vazador/prompt.md'], 'Chame com [segredo:chave de API]')
  })

  it('a url e os args do MCP: senha da URL, parâmetro da query, `--flag valor`, `--flag=valor` e URI do banco', () => {
    const mcp = JSON.parse(files['projects/alfa/mcps/banco.json'])
    assert.strictEqual(mcp.url, 'https://user:[segredo:senha na URL]@n8n.example.com/mcp?access_token=[segredo:access_token]&region=sa-east-1')
    assert.deepStrictEqual(mcp.process.args, [
      '-y',
      'pg-mcp',
      '--password',
      '[segredo:password]',
      '--api-key=[segredo:api_key]',
      '--port',
      '5432',
      'postgres://app:[segredo:senha do banco]@db:5432/app',
    ])
    // Os nomes do que o servidor pede ao cofre seguem (são nomes, não valores).
    assert.deepStrictEqual(mcp.secrets, ['env:PGPASSWORD', 'header'])
  })

  it('o relatório: arquivo, campo, camada e rótulo — nunca o valor', () => {
    const report = manifest.masked.map((item) => `${item.path} · ${item.field} · ${item.layer} · ${item.label}`)
    assert.deepStrictEqual(report, [
      'projects/alfa/skills/deploy/SKILL.md · body · value · senha do banco',
      'projects/alfa/skills/deploy/SKILL.md · body · shape · API_TOKEN',
      'projects/alfa/skills/deploy/SKILL.md · body · format · token do GitHub',
      'projects/alfa/mcps/banco.json · process.args[3] · shape · password',
      'projects/alfa/mcps/banco.json · process.args[4] · shape · api_key',
      'projects/alfa/mcps/banco.json · process.args[7] · value · senha do banco',
      'projects/alfa/mcps/banco.json · url · shape · senha na URL',
      'projects/alfa/mcps/banco.json · url · shape · access_token',
      'projects/alfa/agents/vazador/prompt.md · systemPrompt · format · chave de API',
      'projects/alfa/agents/vazador/agent.json · env.GH_TOKEN · shape · GH_TOKEN',
    ])
    assert.ok(manifest.masked.every((item) => item.kind && item.id && item.projectId === 'alfa'))
    assert.ok(!JSON.stringify(manifest).includes(OPAQUE))
    // Os acertos da máscara também vão para a lista da tela (só metadado); a senha da URL é do export.
    assert.ok(masker.recentHits().length >= manifest.masked.filter((item) => item.label !== 'senha na URL').length)
  })

  it('⛔ só os campos permitidos: nada fora da forma no agent.json, no MCP e no projeto', () => {
    const allowed = (shape: object, extra: string[]) => new Set([...Object.keys(shape), ...extra])
    const agentKeys = allowed(AGENT_SHAPE, Object.keys(AGENT_LINKS_SHAPE))
    const mcpKeys = allowed(MCP_SHAPE, ['secrets'])
    const projectKeys = allowed(PROJECT_SHAPE, ['initialContext'])
    for (const [path, content] of Object.entries(files)) {
      const keys = path.endsWith('/agent.json') ? agentKeys : path.includes('/mcps/') ? mcpKeys : path.endsWith('/project.json') ? projectKeys : undefined
      if (!keys) continue
      for (const key of Object.keys(JSON.parse(content))) assert.ok(keys.has(key), `${path}: ${key}`)
    }
    assert.ok(!everything.includes('apiKey'))
  })

  it('o manifesto: o hash de cada arquivo (menos ele mesmo), e só ele muda entre dois exports', () => {
    assert.deepStrictEqual(
      Object.keys(manifest.files),
      paths(files).filter((path) => path !== MANIFEST_PATH),
    )
    for (const [path, hash] of Object.entries(manifest.files)) assert.strictEqual(hash, createHash('sha256').update(files[path], 'utf8').digest('hex'), path)
    assert.deepStrictEqual(JSON.parse(files[MANIFEST_PATH]), JSON.parse(JSON.stringify(manifest)))
    const later = new CatalogExportUseCase({ reader: { list: () => [], read: () => undefined }, mask: masker })
    assert.strictEqual(later.run({ kind: 'all' }).manifest.masked.length, 0)
  })
})
