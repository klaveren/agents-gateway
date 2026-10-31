import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  agentDocument,
  docDocument,
  ICatalogDocument,
  mcpDocument,
  projectDocument,
  projectPermissionsDocument,
  protocolDocument,
  resourceDocument,
  ruleDocument,
} from './Catalog.Document'
import { catalogFiles, documentsFromFiles, fileOfField, flattenFiles, slugOf, TCatalogFiles } from './Catalog.Files'
import { EMode } from './enums/EMode.Enum'

const at = new Date('2026-10-30T12:00:00.000Z')

/** Um catálogo com um item de cada tipo, global e do projeto `alfa`. */
function documents(): ICatalogDocument[] {
  const scoped = (projectId?: string): ICatalogDocument[] => {
    const scope = projectId ? { projectId } : {}
    const tag = projectId ?? 'g'
    return [
      docDocument({
        id: `spec-${tag}`,
        kind: 'spec',
        ...scope,
        title: 'Spec: "aspas"',
        summary: 'Linha 1\nLinha 2',
        body: '# Spec\n---\nnão é frontmatter\n',
        docIds: [],
        createdAt: at,
        updatedAt: at,
      }),
      docDocument({ id: `adr-${tag}`, kind: 'adr', ...scope, title: 'ADR 1', summary: 'Decisão', body: 'Corpo do ADR', createdAt: at, updatedAt: at }),
      docDocument({
        id: `kn-${tag}`,
        kind: 'knowledge',
        ...scope,
        title: 'Conhecimento ✓',
        summary: 'Resumo',
        body: '',
        docIds: [`spec-${tag}`],
        docRefs: [`spec-${tag}`],
        createdAt: at,
        updatedAt: at,
      }),
      resourceDocument({
        id: `skill-${tag}`,
        kind: 'skill',
        ...scope,
        description: 'Revisa código: rápido',
        body: 'Passos\n',
        docIds: [`spec-${tag}`, `adr-${tag}`],
        docRefs: [`adr-${tag}`],
        createdAt: at,
        updatedAt: at,
      }),
      resourceDocument({ id: `cmd-${tag}`, kind: 'command', ...scope, description: 'Roda', body: '$ARGUMENTS', docIds: [], createdAt: at, updatedAt: at }),
      ruleDocument({ id: `11111111-${tag}`, ...scope, position: 1, title: 'Seja breve', body: 'Responda curto.', enabled: true, createdAt: at, updatedAt: at }),
      ruleDocument({ id: `22222222-${tag}`, ...scope, position: 2, title: 'Seja breve!', body: 'De novo.', enabled: false, createdAt: at, updatedAt: at }),
      protocolDocument({ kind: 'skill', ...scope, body: `Complemento ${tag}`, updatedAt: at }),
      mcpDocument({
        id: `mcp-${tag}`,
        name: 'MCP',
        kind: 'process',
        process: { command: 'npx', args: ['-y', 'pkg'], env: ['API_TOKEN'], scope: 'conversation' },
        url: '',
        transport: 'auto',
        auth: 'header',
        headerName: 'Authorization',
        enabled: true,
        ...scope,
        createdAt: at,
        updatedAt: at,
      }),
      agentDocument(
        {
          id: `agente-${tag}`,
          name: 'Agente',
          providers: [{ provider: 'claude', models: ['opus'] }],
          soul: 'Calmo.\n',
          systemPrompt: '# Prompt\n---\n',
          modes: [EMode.AGENT],
          allowedTools: ['cap:terminal'],
          env: { GIT_AUTHOR_NAME: 'Bot' },
          ...scope,
        },
        { resources: { skills: ['*'], commands: [] }, initialContext: [`spec-${tag}`] },
      ),
    ]
  }
  return [
    projectDocument({ id: 'alfa', name: 'Alfa', description: 'O projeto', createdAt: at, updatedAt: at }, ['spec-alfa']),
    projectPermissionsDocument('alfa', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }]),
    ...scoped(),
    ...scoped('alfa'),
    // Agente sem soul: sem `soul.md`.
    agentDocument({ id: 'sem-alma', name: 'S', providers: [], systemPrompt: '', modes: [], allowedTools: [] }, { resources: { skills: [], commands: [] }, initialContext: [] }),
  ]
}

const key = (document: ICatalogDocument) => `${document.kind}:${document.projectId ?? ''}:${document.id}`
const byKey = (items: ICatalogDocument[]) => new Map(items.map((item) => [key(item), item]))

describe('Catalog.Files — documento → arquivos', () => {
  const entries = catalogFiles(documents())
  const files = flattenFiles(entries)

  it('a árvore espelha o tipo e o escopo', () => {
    assert.deepStrictEqual(Object.keys(files).sort(), [
      'global/adrs/adr-g.md',
      'global/agents/agente-g/agent.json',
      'global/agents/agente-g/prompt.md',
      'global/agents/agente-g/soul.md',
      'global/agents/sem-alma/agent.json',
      'global/agents/sem-alma/prompt.md',
      'global/commands/cmd-g.md',
      'global/knowledge/kn-g.md',
      'global/mcps/mcp-g.json',
      'global/protocols/skill.md',
      'global/rules/seja-breve-22222222-g.md',
      'global/rules/seja-breve.md',
      'global/skills/skill-g/SKILL.md',
      'global/specs/spec-g.md',
      'projects/alfa/adrs/adr-alfa.md',
      'projects/alfa/agents/agente-alfa/agent.json',
      'projects/alfa/agents/agente-alfa/prompt.md',
      'projects/alfa/agents/agente-alfa/soul.md',
      'projects/alfa/commands/cmd-alfa.md',
      'projects/alfa/knowledge/kn-alfa.md',
      'projects/alfa/mcps/mcp-alfa.json',
      'projects/alfa/permissions.json',
      'projects/alfa/project.json',
      'projects/alfa/protocols/skill.md',
      'projects/alfa/rules/seja-breve-22222222-alfa.md',
      'projects/alfa/rules/seja-breve.md',
      'projects/alfa/skills/skill-alfa/SKILL.md',
      'projects/alfa/specs/spec-alfa.md',
    ])
  })

  it('texto em .md com frontmatter: o projectId é a pasta, o corpo é o body', () => {
    assert.strictEqual(
      files['projects/alfa/skills/skill-alfa/SKILL.md'],
      '---\ndescription: "Revisa código: rápido"\ndocRefs: ["adr-alfa"]\ndocs: ["spec-alfa","adr-alfa"]\nname: skill-alfa\n---\nPassos\n',
    )
    assert.strictEqual(files['global/commands/cmd-g.md'], '---\ndescription: Roda\ndocs: []\n---\n$ARGUMENTS')
    assert.strictEqual(files['global/rules/seja-breve.md'], '---\nenabled: true\nid: "11111111-g"\nposition: 1\ntitle: Seja breve\n---\nResponda curto.')
    assert.strictEqual(
      files['global/specs/spec-g.md'],
      '---\ndocs: []\nid: spec-g\nsummary: "Linha 1\\nLinha 2"\ntitle: "Spec: \\"aspas\\""\n---\n# Spec\n---\nnão é frontmatter\n',
    )
    assert.strictEqual(files['projects/alfa/protocols/skill.md'], '---\nkind: skill\n---\nComplemento alfa')
    for (const [path, content] of Object.entries(files)) if (path.endsWith('.md') && !path.includes('/agents/')) assert.ok(!/^projectId:/m.test(content), path)
  })

  it('estrutura em JSON canônico; o agente sem soul e prompt no agent.json', () => {
    const agent = JSON.parse(files['projects/alfa/agents/agente-alfa/agent.json'])
    assert.strictEqual(agent.soul, undefined)
    assert.strictEqual(agent.systemPrompt, undefined)
    assert.deepStrictEqual([agent.projectId, agent.env, agent.initialContext], ['alfa', { GIT_AUTHOR_NAME: 'Bot' }, ['spec-alfa']])
    assert.strictEqual(files['projects/alfa/agents/agente-alfa/soul.md'], 'Calmo.\n')
    assert.strictEqual(files['projects/alfa/agents/agente-alfa/prompt.md'], '# Prompt\n---\n')
    assert.ok(files['global/mcps/mcp-g.json'].startsWith('{\n  "auth": "header",\n'))
    assert.deepStrictEqual(JSON.parse(files['global/mcps/mcp-g.json']).secrets, ['env:API_TOKEN', 'header'])
    assert.deepStrictEqual(JSON.parse(files['projects/alfa/project.json']), { description: 'O projeto', id: 'alfa', initialContext: ['spec-alfa'], name: 'Alfa' })
    assert.ok(files['projects/alfa/permissions.json'].endsWith('}\n'))
  })

  it('o arquivo de cada campo: soul e prompt do agente nos .md, o resto no agent.json', () => {
    const agent = entries.find((entry) => entry.document.id === 'agente-g')!
    assert.strictEqual(fileOfField(agent, 'soul'), 'global/agents/agente-g/soul.md')
    assert.strictEqual(fileOfField(agent, 'systemPrompt'), 'global/agents/agente-g/prompt.md')
    assert.strictEqual(fileOfField(agent, 'env.GH_TOKEN'), 'global/agents/agente-g/agent.json')
    assert.strictEqual(
      fileOfField(
        entries.find((entry) => entry.document.id === 'skill-g')!,
        'body',
      ),
      'global/skills/skill-g/SKILL.md',
    )
  })

  it('slug da rule: sem acento, minúsculo, e o id no fim só na colisão', () => {
    assert.strictEqual(slugOf('Ação: Revisão de Código!'), 'acao-revisao-de-codigo')
    assert.strictEqual(slugOf('!!!'), 'rule')
  })
})

describe('Catalog.Files — ida e volta (arquivos → documentos → arquivos)', () => {
  it('os documentos voltam iguais, com o mesmo hash, e os arquivos de novo idênticos', () => {
    const original = documents()
    const files = flattenFiles(catalogFiles(original))
    const { documents: back, errors } = documentsFromFiles({ ...files, 'catalog.json': '{}' })
    assert.deepStrictEqual(errors, [])
    assert.strictEqual(back.length, original.length)
    const expected = byKey(original)
    for (const document of back) {
      const before = expected.get(key(document))
      assert.ok(before, key(document))
      assert.deepStrictEqual(document.body, before.body, key(document))
      assert.strictEqual(document.hash, before.hash, key(document))
    }
    assert.deepStrictEqual(flattenFiles(catalogFiles(back)), files)
  })

  it('⛔ arquivo fora do formato vira erro com o caminho; os outros seguem', () => {
    const files: TCatalogFiles = {
      'global/specs/ok-spec.md': '---\nid: ok-spec\ntitle: T\nsummary: S\n---\nB',
      'global/specs/outro.md': '---\nid: diferente\ntitle: T\nsummary: S\n---\nB',
      'global/specs/yaml.md': '---\ntitle: |\n  bloco\n---\nB',
      'global/commands/c1.md': '---\nid: c1\ndescription: D\n---\nB',
      'global/skills/s1/SKILL.md': '---\nname: s1\nprojectId: alfa\ndescription: D\n---\nB',
      'global/protocols/nada.md': '---\nkind: nada\n---\nB',
      'global/agents/sem-json/soul.md': 'alma',
      'global/agents/a1/agent.json': '{"id":"a1","name":"A","systemPrompt":"x"}',
      'global/mcps/m1.json': '{"id":"m1","projectId":"alfa"}',
      'projects/alfa/project.json': '{"id":"beta"}',
      'projects/alfa/../../segredo.md': 'x',
      'outro/lugar.md': 'x',
      'global/desconhecido/x.md': 'x',
      'global/mcps/quebrado.json': '{',
    }
    const { documents: back, errors } = documentsFromFiles(files)
    assert.deepStrictEqual(
      back.map((document) => document.id),
      ['ok-spec'],
    )
    const messages = Object.fromEntries(errors.map((error) => [error.path, error.message]))
    assert.match(messages['global/specs/outro.md'], /difere do arquivo/)
    assert.match(messages['global/specs/yaml.md'], /frontmatter, linha 2/)
    assert.match(messages['global/commands/c1.md'], /nome do arquivo/)
    assert.match(messages['global/skills/s1/SKILL.md'], /projectId/)
    assert.match(messages['global/protocols/nada.md'], /desconhecido/)
    assert.match(messages['global/agents/sem-json/agent.json'], /falta/)
    assert.match(messages['global/agents/a1/agent.json'], /prompt\.md/)
    assert.match(messages['global/mcps/m1.json'], /projectId/)
    assert.match(messages['projects/alfa/project.json'], /difere da pasta/)
    assert.match(messages['projects/alfa/../../segredo.md'], /caminho inválido/)
    assert.match(messages['outro/lugar.md'], /fora de/)
    assert.match(messages['global/desconhecido/x.md'], /fora do formato/)
    assert.match(messages['global/mcps/quebrado.json'], /JSON inválido/)
  })
})
