import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { NO_RESOURCES } from '@domain/models/Resource.Model'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { CatalogReader } from './Catalog.Reader'

const at = new Date('2026-10-30T12:00:00.000Z')
const SECRET = 'sk-ant-api03-nunca-no-catalogo'

const agent = (id: string, projectId?: string): IAgent => ({
  id,
  name: id.toUpperCase(),
  providers: [{ provider: 'claude', models: ['opus'] }],
  systemPrompt: `Prompt de ${id}`,
  modes: [EMode.AGENT],
  allowedTools: ['cap:terminal'],
  ...(projectId ? { projectId } : {}),
})

/** Um gateway com dois projetos (`a` e `b`), itens globais e um MCP. `reverse` grava tudo na ordem inversa. */
function build(reverse = false) {
  const deps = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const { agents, guidance, permissions, mcps, projects } = deps
  const steps: Array<() => void> = [
    () => projects.insert({ id: 'a', name: 'Projeto A', createdAt: at, updatedAt: at, updatedBy: 'ana' }),
    () => projects.insert({ id: 'b', name: 'Projeto B', description: 'O outro', createdAt: at, updatedAt: at }),
    ...(['a', 'b', undefined] as const).flatMap((projectId) => {
      const tag = projectId ?? 'g'
      return [
        () =>
          guidance.insertDoc({ id: `spec-${tag}`, kind: 'spec', ...(projectId ? { projectId } : {}), title: `Spec ${tag}`, summary: 'S', body: 'B', createdAt: at, updatedAt: at }),
        () =>
          guidance.insertDoc({ id: `adr-${tag}`, kind: 'adr', ...(projectId ? { projectId } : {}), title: `ADR ${tag}`, summary: 'S', body: 'B', createdAt: at, updatedAt: at }),
        () =>
          guidance.saveResource({
            id: `skill-${tag}`,
            kind: 'skill',
            ...(projectId ? { projectId } : {}),
            description: 'D',
            body: 'B',
            docIds: [`spec-${tag}`],
            createdAt: at,
            updatedAt: at,
          }),
        () =>
          guidance.saveResource({
            id: `cmd-${tag}`,
            kind: 'command',
            ...(projectId ? { projectId } : {}),
            description: 'D',
            body: '$ARGUMENTS',
            docIds: [],
            createdAt: at,
            updatedAt: at,
          }),
        () => guidance.insertRule({ id: `rule-${tag}`, ...(projectId ? { projectId } : {}), position: 1, title: 'R', body: 'B', enabled: true, createdAt: at, updatedAt: at }),
        () => guidance.setProtocolAddendum('skill', projectId ?? null, { kind: 'skill', ...(projectId ? { projectId } : {}), body: `Mais ${tag}`, updatedAt: at }),
        () => agents.save({ ...agent(`agente-${tag}`, projectId), apiKey: SECRET } as IAgent, 'ana'),
      ]
    }),
    () => guidance.setContextDocs('a', ['spec-a', 'spec-g'], 'ana'),
    () => guidance.setAgentContextDocs('agente-a', ['spec-a'], 'ana'),
    () => guidance.setAgentResources('agente-a', { skills: ['skill-a'], commands: [NO_RESOURCES] }, 'ana'),
    () => permissions.saveProjectRules('a', [{ category: 'terminal', pattern: 'git *', decision: 'allow' }], 'ana'),
    () =>
      mcps.insert({
        id: 'gh',
        name: 'GitHub',
        url: 'https://mcp.example.com/',
        transport: 'auto',
        auth: 'header',
        headerName: 'Authorization',
        enabled: true,
        createdAt: at,
        updatedAt: at,
      }),
  ]
  for (const step of reverse ? [...steps].reverse() : steps) step()
  return new CatalogReader(deps)
}

const ids = (documents: Array<{ kind: string; id: string }>) => documents.map((doc) => `${doc.kind}:${doc.id}`)

describe('CatalogReader — por escopo', () => {
  it('⛔ projeto A só traz o que é de A: nada de B, nada global, nada do sistema', () => {
    const documents = build().list({ kind: 'project', projectId: 'a' })
    assert.deepStrictEqual(ids(documents), [
      'project:a',
      'spec:spec-a',
      'adr:adr-a',
      'skill:skill-a',
      'command:cmd-a',
      'rule:rule-a',
      'protocol:a/skill',
      'agent:agente-a',
      'project-permissions:a',
    ])
    assert.ok(documents.every((doc) => doc.projectId === 'a'))
    assert.ok(!documents.some((doc) => doc.text.includes('-b"') || doc.text.includes('Projeto B')))
  })

  it('global: só o que não é de projeto, e os MCPs', () => {
    const documents = build().list({ kind: 'global' })
    assert.deepStrictEqual(ids(documents), ['spec:spec-g', 'adr:adr-g', 'skill:skill-g', 'command:cmd-g', 'rule:rule-g', 'protocol:skill', 'mcp:gh', 'agent:agente-g'])
    assert.ok(documents.every((doc) => doc.projectId === undefined))
  })

  it('tudo: os globais, os dois projetos e os MCPs, sem repetir', () => {
    const documents = build().list({ kind: 'all' })
    assert.strictEqual(documents.length, 9 * 2 + 8)
    assert.strictEqual(new Set(ids(documents)).size, documents.length)
  })

  it('projeto que não existe: vazio', () => {
    assert.deepStrictEqual(build().list({ kind: 'project', projectId: 'zzz' }), [])
  })

  it('⚖️ gravar em outra ordem dá a mesma lista, texto a texto', () => {
    const texts = (reader: CatalogReader) => reader.list({ kind: 'all' }).map((doc) => [doc.kind, doc.id, doc.hash])
    assert.deepStrictEqual(texts(build(true)), texts(build()))
  })
})

describe('CatalogReader — documento de um item', () => {
  const reader = build()

  it('o agente junta as duas tabelas: recursos efetivos e contexto inicial; sem marcação = `*`', () => {
    const a = reader.read('agent', 'agente-a')!
    assert.deepStrictEqual(a.body.resources, { skills: ['skill-a'], commands: [] })
    assert.deepStrictEqual(a.body.initialContext, ['spec-a'])
    const g = reader.read('agent', 'agente-g')!
    assert.deepStrictEqual(g.body.resources, { skills: ['*'], commands: ['*'] })
    assert.deepStrictEqual(g.body.initialContext, [])
  })

  it('⛔ campo a mais no JSON gravado do agente não sai', () => {
    for (const doc of reader.list({ kind: 'all' })) assert.ok(!doc.text.includes(SECRET), `${doc.kind}:${doc.id}`)
  })

  it('o projeto leva o contexto inicial; as permissões vêm sem quem/quando', () => {
    assert.deepStrictEqual(reader.read('project', 'a')!.body, { id: 'a', name: 'Projeto A', initialContext: ['spec-a', 'spec-g'] })
    assert.deepStrictEqual(reader.read('project-permissions', 'a')!.body, { projectId: 'a', rules: [{ category: 'terminal', pattern: 'git *', decision: 'allow' }] })
    assert.deepStrictEqual(reader.read('project-permissions', 'b')!.body, { projectId: 'b', rules: [] })
    assert.strictEqual(reader.read('project-permissions', 'zzz'), undefined)
  })

  it('MCP: o nome do header e o que falta no cofre, nunca valor', () => {
    const doc = reader.read('mcp', 'gh')!
    assert.deepStrictEqual(doc.body.secrets, ['header'])
    assert.ok(!/updatedAt|createdAt/.test(doc.text))
  })

  it('o tipo tem de bater: skill não responde como command, spec não responde como adr', () => {
    assert.ok(reader.read('skill', 'skill-a'))
    assert.strictEqual(reader.read('command', 'skill-a'), undefined)
    assert.strictEqual(reader.read('adr', 'spec-a'), undefined)
    assert.deepStrictEqual(reader.read('skill', 'skill-a')!.body.docIds, ['spec-a'])
  })

  it('complemento: global pelo tipo, do projeto por `<projeto>/<tipo>`', () => {
    assert.deepStrictEqual(reader.read('protocol', 'skill')!.body, { kind: 'skill', body: 'Mais g' })
    assert.deepStrictEqual(reader.read('protocol', 'b/skill')!.body, { kind: 'skill', projectId: 'b', body: 'Mais b' })
    assert.strictEqual(reader.read('protocol', 'b/rule'), undefined)
    assert.strictEqual(reader.read('protocol', 'zzz/skill'), undefined)
  })

  it('o documento lido sozinho é o mesmo da lista', () => {
    for (const doc of reader.list({ kind: 'all' })) assert.strictEqual(reader.read(doc.kind, doc.id)?.hash, doc.hash, `${doc.kind}:${doc.id}`)
  })

  it('item que não existe: undefined', () => {
    assert.strictEqual(reader.read('agent', 'ninguem'), undefined)
    assert.strictEqual(reader.read('rule', 'nada'), undefined)
  })
})
