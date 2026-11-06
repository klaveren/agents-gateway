import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { InvalidProjectError, ProjectInUseError } from '@domain/errors/Domain.Error'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { CLAUDE_TEST_AGENT, GOOGLE_TEST_AGENT, testAgentCatalog } from '../testing/Agents.Fixture'
import { migrateProjectRoles, migrateLegacyToProjects, ProjectsService } from './Projects.Service'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'

describe('ProjectsService', () => {
  const build = () => {
    const root = mkdtempSync(join(tmpdir(), 'gw-projects-svc-'))
    const repository = new SqliteProjectRepository(':memory:')
    const agents = testAgentCatalog()
    const service = new ProjectsService(
      repository,
      () => agents.list(),
      (id) => id.startsWith('u_'),
      {
        create: (id) => (mkdirSync(join(root, id), { recursive: true }), join(root, id)),
        remove: (id) => rmSync(join(root, id), { recursive: true, force: true }),
      },
    )
    return { service, repository, agents, root }
  }

  it('⛔ canUse: o admin usa todos; o membro, só os seus; projeto inexistente, ninguém', () => {
    const { service } = build()
    service.create({ id: 'alfa', name: 'Alfa' }, 'root')
    service.setMembers('alfa', [{ userId: 'u_ana', role: 'admin' }], 'root')
    assert.strictEqual(service.canUse({ admin: true }, 'alfa'), true)
    assert.strictEqual(service.canUse({ userId: 'u_ana', admin: false }, 'alfa'), true)
    assert.strictEqual(service.canUse({ userId: 'u_bia', admin: false }, 'alfa'), false)
    assert.strictEqual(service.canUse({ admin: true }, 'nao-existe'), false)
    assert.deepStrictEqual(service.list({ userId: 'u_bia', admin: false }), [])
    // ⛔ A lista é dos projetos de que a pessoa é membro — também para o administrador do gateway.
    assert.deepStrictEqual(service.list({ userId: 'u_root', admin: true }), [])
    assert.deepStrictEqual(
      service.all().map((project) => project.id),
      ['alfa'],
    )
  })

  it('⛔ papéis: quem cria vira administrador; todo projeto fica com ao menos um; sem papel dito, fica o que tinha', () => {
    const { service } = build()
    service.create({ id: 'alfa', name: 'Alfa' }, 'root', 'api', 'u_ana')
    assert.deepStrictEqual(
      service.members('alfa').map((member) => [member.userId, member.role]),
      [['u_ana', 'admin']],
    )
    assert.strictEqual(service.roleOf('alfa', 'u_ana'), 'admin')
    // Entra a Bia como membro; a Ana segue administradora (sem papel dito).
    service.setMembers('alfa', ['u_ana', { userId: 'u_bia', role: 'member' }], 'u_ana')
    assert.deepStrictEqual(
      service.members('alfa').map((member) => [member.userId, member.role]),
      [
        ['u_ana', 'admin'],
        ['u_bia', 'member'],
      ],
    )
    // Tirar ou rebaixar o último administrador: recusado.
    assert.throws(() => service.setMembers('alfa', ['u_bia'], 'u_ana'), /at least one admin/)
    assert.throws(() => service.setMembers('alfa', [{ userId: 'u_ana', role: 'member' }, 'u_bia'], 'u_ana'), /at least one admin/)
    assert.strictEqual(service.roleOf('alfa', 'u_bia'), 'member')
    assert.strictEqual(service.roleOf('alfa', 'u_root'), undefined)
  })

  it('a migração dos papéis: o membro que administra o gateway vira administrador; o projeto sem nenhum ganha os do gateway — uma vez', () => {
    const { service, repository } = build()
    service.create({ id: 'alfa', name: 'Alfa' }, 'root')
    service.create({ id: 'beta', name: 'Beta' }, 'root')
    // Como era antes: membros sem papel (todos `member`).
    repository.setMembers(
      'alfa',
      [
        { userId: 'u_root', role: 'member' },
        { userId: 'u_ana', role: 'member' },
      ],
      'root',
    )
    repository.setMembers('beta', [{ userId: 'u_bia', role: 'member' }], 'root')
    assert.strictEqual(migrateProjectRoles({ repository, adminIds: () => ['u_root'] }), 2)
    assert.deepStrictEqual(
      service
        .members('alfa')
        .map((member) => [member.userId, member.role])
        .sort(),
      [
        ['u_ana', 'member'],
        ['u_root', 'admin'],
      ],
    )
    assert.deepStrictEqual(
      service
        .members('beta')
        .map((member) => [member.userId, member.role])
        .sort(),
      [
        ['u_bia', 'member'],
        ['u_root', 'admin'],
      ],
    )
    assert.strictEqual(migrateProjectRoles({ repository, adminIds: () => ['u_root'] }), 0, 'uma vez só')
  })

  it('valida id e nome; membros só de contas que existem; apagar com agente, 409', () => {
    const { service, agents } = build()
    assert.throws(
      () => service.create({ id: 'X', name: ' ' }, 'root'),
      (error: InvalidProjectError) => error.issues.map((issue) => issue.field).join() === 'id,name',
    )
    service.create({ id: 'alfa', name: 'Alfa' }, 'root')
    assert.throws(() => service.create({ id: 'alfa', name: 'De novo' }, 'root'), InvalidProjectError)
    assert.throws(() => service.setMembers('alfa', ['fantasma'], 'root'), InvalidProjectError)
    agents.moveToProject(CLAUDE_TEST_AGENT.id, 'alfa', 'root')
    assert.throws(() => service.remove('alfa', 'admin'), ProjectInUseError)
  })

  it('a migração põe os agentes antigos e as conversas deles no `geral`, com todos como membros — uma vez só; a semente fica global', async () => {
    const { service, repository, agents } = build()
    const conversations = new SqliteConversationRepository(':memory:')
    const now = new Date()
    await conversations.saveSession({
      id: 'c1',
      agentId: CLAUDE_TEST_AGENT.id,
      provider: EProvider.CLAUDE,
      mode: EMode.CHAT,
      model: 'm',
      turns: 1,
      usage: {},
      metadata: { owner: { id: 'u_ana' } },
      createdAt: now,
      updatedAt: now,
    } as never)
    const result = await migrateLegacyToProjects({ service, repository, agents, conversations, userIds: () => ['u_ana', 'u_bia'], seedIds: [GOOGLE_TEST_AGENT.id] })
    assert.deepStrictEqual(result, { agents: 2, conversations: 1 })
    assert.deepStrictEqual(
      service.members('geral').map((member) => [member.userId, member.role]),
      [
        ['u_ana', 'admin'],
        ['u_bia', 'member'],
      ],
      'sem administrador do gateway dito, o primeiro administra',
    )
    assert.strictEqual(agents.get(CLAUDE_TEST_AGENT.id)?.projectId, 'geral')
    assert.strictEqual(agents.get(GOOGLE_TEST_AGENT.id)?.projectId, undefined, 'a semente fica global')
    assert.strictEqual((await conversations.listSessions({ filter: { project: 'geral' } })).length, 1)
    assert.strictEqual(await migrateLegacyToProjects({ service, repository, agents, conversations, userIds: () => [], seedIds: [] }), undefined, 'roda uma vez só')
  })

  it('ignorar do importador: guarda normalizado, troca a lista inteira, recusa absoluto e `..`', () => {
    const { service } = build()
    service.create({ id: 'alfa', name: 'Alfa' }, 'root')
    assert.deepStrictEqual(service.importIgnore('alfa'), [])
    assert.deepStrictEqual(service.setImportIgnore('alfa', [' ./.agents/benchmark/results/ ', 'results', 'results', '**/*.log'], 'root'), [
      '.agents/benchmark/results',
      'results',
      '**/*.log',
    ])
    assert.deepStrictEqual(service.get('alfa').importIgnore, ['.agents/benchmark/results', 'results', '**/*.log'])
    for (const bad of ['/etc/**', '~/x', 'a/../../b', ''])
      assert.throws(
        () => service.setImportIgnore('alfa', [bad], 'root'),
        (error: unknown) => error instanceof InvalidProjectError && error.issues[0].field === 'patterns.0',
        bad,
      )
    assert.deepStrictEqual(service.importIgnore('alfa'), ['.agents/benchmark/results', 'results', '**/*.log'], 'a recusa não mexe no guardado')
    assert.deepStrictEqual(service.setImportIgnore('alfa', [], 'root'), [])
    assert.strictEqual(service.get('alfa').importIgnore, undefined)
  })

  it('ambiente agêntico do importador: padrão sem nada guardado; troca inteiro, normaliza e recusa o inválido', () => {
    const { service } = build()
    service.create({ id: 'alfa', name: 'Alfa' }, 'root')
    assert.deepStrictEqual(service.importScope('alfa'), { disabled: [], extra: [] })
    assert.deepStrictEqual(service.setImportScope('alfa', { disabled: ['GEMINI.md', '.cursor/'], extra: [' ./docs/ '] }, 'root'), {
      disabled: ['.cursor/', 'GEMINI.md'],
      extra: ['docs'],
    })
    assert.deepStrictEqual(service.get('alfa').importScope, { disabled: ['.cursor/', 'GEMINI.md'], extra: ['docs'] })
    for (const [scope, field] of [
      [{ disabled: ['src/'], extra: [] }, 'disabled.0'],
      [{ disabled: [], extra: ['../fora'] }, 'extra.0'],
    ] as const)
      assert.throws(
        () => service.setImportScope('alfa', { disabled: [...scope.disabled], extra: [...scope.extra] }, 'root'),
        (error: unknown) => error instanceof InvalidProjectError && error.issues[0].field === field,
      )
    assert.deepStrictEqual(service.importScope('alfa').extra, ['docs'], 'a recusa não mexe no guardado')
    assert.deepStrictEqual(service.setImportScope('alfa', { disabled: [], extra: [] }, 'root'), { disabled: [], extra: [] })
    assert.strictEqual(service.get('alfa').importScope, undefined)
  })

  it('banco antigo, sem a coluna do ignorar, ganha a coluna na abertura e mantém os projetos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-projects-old-'))
    const path = join(dir, 'old.db')
    const old = new DatabaseSync(path)
    old.exec(
      "CREATE TABLE projects (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT); INSERT INTO projects VALUES ('alfa', 'Alfa', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)",
    )
    old.close()
    const repository = new SqliteProjectRepository(path)
    assert.strictEqual(repository.get('alfa')?.importIgnore, undefined)
    assert.deepStrictEqual(repository.update('alfa', { importIgnore: ['results'] })?.importIgnore, ['results'])
    assert.deepStrictEqual(repository.update('alfa', { importScope: { disabled: ['.roo/'], extra: [] } })?.importScope, { disabled: ['.roo/'], extra: [] })
    rmSync(dir, { recursive: true, force: true })
  })
})
