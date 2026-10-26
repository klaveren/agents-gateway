import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { SqliteAgentRepository, withProviders } from './Sqlite.AgentRepository'

describe('SqliteAgentRepository', () => {
  const agent: IAgent = {
    id: 'juridico',
    name: 'Jurídico',
    providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5'] }],
    systemPrompt: 'pesquise',
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
    repo.seedOnce([{ ...agent, id: 'pesquisa-teste' }], 'seed')
    repo.delete('pesquisa-teste')

    repo.seedOnce(
      [
        { ...agent, id: 'pesquisa-teste' },
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
    repo.save({ ...agent, id: 'operador', name: 'Meu Operador' }, 'root')

    repo.seedOnce(
      [
        { ...agent, id: 'operador', name: 'Semente' },
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
        ['operador', 'Meu Operador'],
        ['pesquisa', agent.name],
      ],
    )

    repo.delete('pesquisa')
    repo.seedOnce([{ ...agent, id: 'pesquisa' }], 'seed')
    assert.deepStrictEqual(
      repo.list().map((item) => item.id),
      ['operador'],
    )
  })

  it('⚖️ o documento de antes (`provider` + `models`) é lido como um `providers` de um item, sem migração', () => {
    const repo = new SqliteAgentRepository(':memory:')
    const legacy = { id: 'velho', name: 'Velho', provider: 'claude', models: ['claude-sonnet-5'], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: [] }
    repo.seedOnce([legacy as unknown as IAgent], 'seed')

    const [read] = repo.list()
    assert.deepStrictEqual(read.providers, [{ provider: 'claude', models: ['claude-sonnet-5'] }])
    assert.ok(!('provider' in read) && !('models' in read))
    assert.deepStrictEqual(withProviders({ ...agent }), agent)
  })
})
