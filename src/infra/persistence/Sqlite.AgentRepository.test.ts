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

  it('as variáveis de ambiente do agente vão e voltam no documento', () => {
    const repo = new SqliteAgentRepository(':memory:')
    const env = { GIT_AUTHOR_NAME: 'Maya', GIT_AUTHOR_EMAIL: 'maya@x.test' }
    repo.save({ ...agent, env }, 'x')
    assert.deepStrictEqual(repo.list()[0].env, env)
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

describe('SqliteAgentRepository — ferramentas novas da semente', () => {
  it('⚖️ a ferramenta nova da semente chega ao agente que já existe, uma vez: tirada depois, não volta', () => {
    const repo = new SqliteAgentRepository(':memory:')
    const seed: IAgent = { id: 'atlas', name: 'Atlas', providers: [{ provider: EProvider.GOOGLE, models: ['m'] }], systemPrompt: 'p', modes: [EMode.CHAT], allowedTools: ['a'] }
    repo.seedOnce([seed], 'seed')
    repo.save({ ...seed, systemPrompt: 'editado', allowedTools: [] }, 'root')

    repo.seedOnce([{ ...seed, allowedTools: ['a', 'b'] }], 'seed')
    const atlas = repo.list().find((item) => item.id === 'atlas')!
    assert.deepStrictEqual([atlas.allowedTools, atlas.systemPrompt], [['b'], 'editado'])

    repo.save({ ...atlas, allowedTools: [] }, 'root')
    repo.seedOnce([{ ...seed, allowedTools: ['a', 'b'] }], 'seed')
    assert.deepStrictEqual(repo.list().find((item) => item.id === 'atlas')!.allowedTools, [])
  })

  it('migrateOnce: aplica uma vez por banco, guarda o resto do agente e ignora o que não existe', () => {
    const agent: IAgent = {
      id: 'juridico',
      name: 'Jurídico',
      providers: [{ provider: EProvider.CLAUDE, models: ['m'] }],
      systemPrompt: 'p',
      modes: [EMode.AGENT],
      allowedTools: [],
    }
    const repo = new SqliteAgentRepository(':memory:')
    repo.save({ ...agent, allowedTools: ['velha', 'fica'] }, 'root')
    const drop = (item: IAgent) => ({ ...item, allowedTools: item.allowedTools.filter((tool) => tool !== 'velha') })
    repo.migrateOnce('tirar-velha', 'juridico', drop, 'seed')
    assert.deepStrictEqual(repo.list()[0].allowedTools, ['fica'])
    assert.strictEqual(repo.list()[0].name, 'Jurídico')

    repo.save({ ...agent, allowedTools: ['velha'] }, 'root')
    repo.migrateOnce('tirar-velha', 'juridico', drop, 'seed')
    assert.deepStrictEqual(repo.list()[0].allowedTools, ['velha'])
    repo.migrateOnce('tirar-velha', 'nao-existe', drop, 'seed')
    assert.strictEqual(repo.list().length, 1)
  })
})
