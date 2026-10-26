import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentInUseError, AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { AgentCatalog, ISaveAgentOptions } from './Agent.Catalog'

describe('AgentCatalog', () => {
  const base: IAgent = {
    id: 'pesquisa',
    name: 'Pesquisa',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
    systemPrompt: 'pesquise',
    modes: [EMode.CHAT],
    allowedTools: ['search_web'],
  }
  const custom: IAgent = { ...base, id: 'juridico', name: 'Jurídico' }

  const options = (creating: boolean): ISaveAgentOptions => ({
    rules: { knownTools: ['search_web'], providerOf: () => EProvider.GOOGLE },
    by: 'root@x.test',
    creating,
  })

  const build = () => new AgentCatalog(new NullAgentRepository())

  it('lista os agentes na ordem em que foram criados, e acha cada um por id', () => {
    const catalog = build()
    catalog.save(base, options(true))
    catalog.save(custom, options(true))

    assert.deepStrictEqual(
      catalog.entries().map((entry) => entry.agent.id),
      ['pesquisa', 'juridico'],
    )
    assert.strictEqual(catalog.get('juridico')?.name, 'Jurídico')
    assert.strictEqual(catalog.entry('juridico')?.updatedBy, 'root@x.test')
    assert.strictEqual(catalog.fallback()?.id, 'pesquisa')
  })

  it('todo agente é editável e apagável, inclusive o primeiro', () => {
    const repository = new NullAgentRepository()
    repository.save(base, 'seed')
    const catalog = new AgentCatalog(repository)

    catalog.save({ ...base, name: 'outro' }, options(false))
    assert.strictEqual(catalog.get('pesquisa')?.name, 'outro')

    catalog.remove('pesquisa')
    assert.strictEqual(catalog.get('pesquisa'), undefined)
  })

  it('criar com id já criado é recusado; atualizar o que não existe é 404', () => {
    const catalog = build()
    catalog.save(custom, options(true))

    assert.throws(() => catalog.save(custom, options(true)), InvalidAgentError)
    assert.throws(() => catalog.save({ ...custom, id: 'nunca-criado' }, options(false)), AgentNotFoundError)
  })

  it('atualizar troca o agente; apagar tira da lista', () => {
    const catalog = build()
    catalog.save(custom, options(true))

    catalog.save({ ...custom, name: 'Jurídico 2' }, options(false))
    assert.strictEqual(catalog.get('juridico')?.name, 'Jurídico 2')

    catalog.remove('juridico')
    assert.strictEqual(catalog.get('juridico'), undefined)
    assert.throws(() => catalog.remove('juridico'), AgentNotFoundError)
  })

  it('o papel de subagente sobrevive à gravação; sem ele, volta a agente normal', () => {
    const catalog = build()
    catalog.save({ ...custom, role: 'subagent' }, options(true))
    assert.strictEqual(catalog.get('juridico')?.role, 'subagent')

    catalog.save(custom, options(false))
    assert.strictEqual(catalog.get('juridico')?.role, undefined)
  })

  it('⚖️ só oferece os modelos ATIVADOS no catálogo; desligar tira de todos sem reescrever o agente', () => {
    const enabled = new Set(['claude-sonnet-5'])
    const repository = new NullAgentRepository()
    repository.save({ ...custom, providers: [{ provider: 'claude', models: ['claude-sonnet-5', 'claude-opus-5'] }] }, 'x')
    const catalog = new AgentCatalog(repository, (_provider, model) => enabled.has(model))

    assert.deepStrictEqual(catalog.get('juridico')?.providers[0].models, ['claude-sonnet-5'])
    assert.deepStrictEqual(catalog.unusableModels(repository.list()[0]), { claude: ['claude-opus-5'] })

    enabled.delete('claude-sonnet-5')
    assert.deepStrictEqual(catalog.get('juridico')?.providers[0].models, [])
    assert.deepStrictEqual(repository.list()[0].providers[0].models, ['claude-sonnet-5', 'claude-opus-5'])
  })
  it('o padrão é o primeiro que pode rodar e não é subagente', () => {
    const repository = new NullAgentRepository()
    repository.save(base, 'x')
    repository.save({ ...custom, id: 'sub', role: 'subagent' }, 'x')
    repository.save({ ...custom, id: 'ok' }, 'x')
    const catalog = new AgentCatalog(repository, undefined, (agent) => agent.id !== 'pesquisa')

    assert.strictEqual(catalog.fallback()?.id, 'ok')

    const only = new NullAgentRepository()
    only.save(base, 'x')
    assert.strictEqual(new AgentCatalog(only, undefined, () => false).fallback(), undefined)
  })

  it('⛔ não apaga agente a quem outro delega, nem o padrão das configurações; diz quem referencia', () => {
    const catalog = build()
    catalog.save(custom, options(true))
    catalog.save({ ...custom, id: 'chefe', allowedTools: ['search_web', 'agent:juridico'] }, { ...options(true), rules: { ...options(true).rules, agentExists: () => true } })

    assert.throws(
      () => catalog.remove('juridico'),
      (error: unknown) => error instanceof AgentInUseError && error.delegators.join() === 'chefe' && !error.isDefault,
    )
    assert.throws(
      () => catalog.remove('chefe', { defaultAgentId: 'chefe' }),
      (error: unknown) => error instanceof AgentInUseError && error.isDefault,
    )

    catalog.remove('chefe')
    catalog.remove('juridico')
    assert.strictEqual(catalog.get('juridico'), undefined)
  })
})
