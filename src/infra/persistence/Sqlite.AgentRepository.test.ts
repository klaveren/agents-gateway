import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository } from './Sqlite.AgentRepository'

describe('SqliteAgentRepository', () => {
  const agent: IAgent = {
    id: 'juridico',
    name: 'Jurídico',
    provider: EProvider.CLAUDE,
    systemPrompt: 'pesquise',
    models: ['claude-sonnet-5'],
    reasoningEfforts: ['low'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: [],
  }

  it('grava, relê inteiro e atualiza sem trocar a data de criação', async () => {
    const repo = new SqliteAgentRepository(':memory:')

    const created = repo.save(agent, 'ana@x.test')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const updated = repo.save({ ...agent, name: 'Jurídico 2' }, 'bia@x.test')

    const [listed] = repo.list()
    assert.deepStrictEqual(
      { ...listed, createdAt: undefined, updatedAt: undefined },
      { ...agent, name: 'Jurídico 2', updatedBy: 'bia@x.test', createdAt: undefined, updatedAt: undefined },
    )
    assert.strictEqual(updated.createdAt.getTime(), created.createdAt.getTime())
    assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime())
  })

  it('apagar diz se havia o que apagar', () => {
    const repo = new SqliteAgentRepository(':memory:')
    repo.save(agent, 'x')

    assert.strictEqual(repo.delete('juridico'), true)
    assert.strictEqual(repo.delete('juridico'), false)
    assert.deepStrictEqual(repo.list(), [])
  })

  it('⛔ banco fechado lista vazio em vez de derrubar', () => {
    const repo = new SqliteAgentRepository(':memory:')
    repo.close()

    assert.deepStrictEqual(repo.list(), [])
  })
  it('⚖️ agente NOVO na semente chega a um banco já semeado (marca por agente); o apagado não volta', () => {
    const repo = new SqliteAgentRepository(':memory:')
    repo.seedOnce([{ ...agent, id: 'researcher-agent' }], 'seed')
    repo.delete('researcher-agent')

    repo.seedOnce(
      [
        { ...agent, id: 'researcher-agent' },
        { ...agent, id: 'atlas', soul: 'calmo' },
      ],
      'seed',
    )

    assert.deepStrictEqual(
      repo.list().map((item) => [item.id, item.soul]),
      [['atlas', 'calmo']],
    )
  })

  it('a semente entra UMA vez: agente apagado não volta no boot seguinte, e id existente não é sobrescrito', () => {
    const repo = new SqliteAgentRepository(':memory:')
    repo.save({ ...agent, id: 'sysops', name: 'Meu SysOps' }, 'root')

    repo.seedOnce(
      [
        { ...agent, id: 'sysops', name: 'Semente' },
        { ...agent, id: 'pesquisa' },
      ],
      'seed',
    )
    assert.deepStrictEqual(
      repo
        .list()
        .map((item) => [item.id, item.name])
        .sort(),
      [
        ['pesquisa', agent.name],
        ['sysops', 'Meu SysOps'],
      ],
    )

    repo.delete('pesquisa')
    repo.seedOnce([{ ...agent, id: 'pesquisa' }], 'seed')
    assert.deepStrictEqual(
      repo.list().map((item) => item.id),
      ['sysops'],
    )
  })
})
