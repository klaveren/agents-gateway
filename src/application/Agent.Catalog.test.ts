import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentNotFoundError, InvalidAgentError, ReadOnlyAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { AgentCatalog, ISaveAgentOptions } from './Agent.Catalog'

describe('AgentCatalog', () => {
  const builtIn: IAgent = {
    id: 'researcher-agent',
    name: 'Researcher',
    provider: EProvider.GOOGLE,
    systemPrompt: 'pesquise',
    models: ['gemini-3.7-flash'],
    modes: [EMode.CHAT],
    allowedTools: ['search_web'],
  }
  const custom: IAgent = { ...builtIn, id: 'juridico', name: 'Jurídico' }

  const options = (creating: boolean): ISaveAgentOptions => ({
    rules: { knownTools: ['search_web'], providerOf: () => EProvider.GOOGLE },
    by: 'root@x.test',
    creating,
  })

  const build = () => new AgentCatalog([builtIn], new NullAgentRepository())

  it('lista os embutidos primeiro e os criados depois, e acha os dois por id', () => {
    const catalog = build()
    catalog.save(custom, options(true))

    assert.deepStrictEqual(
      catalog.entries().map((entry) => [entry.agent.id, entry.builtIn]),
      [
        ['researcher-agent', true],
        ['juridico', false],
      ],
    )
    assert.strictEqual(catalog.get('juridico')?.name, 'Jurídico')
    assert.strictEqual(catalog.entry('juridico')?.updatedBy, 'root@x.test')
    assert.strictEqual(catalog.fallback()?.id, 'researcher-agent')
  })

  it('⛔ embutido é só leitura: nem atualizar, nem apagar, nem criar por cima', () => {
    const catalog = build()

    assert.throws(() => catalog.save({ ...builtIn, name: 'outro' }, options(false)), ReadOnlyAgentError)
    assert.throws(() => catalog.remove('researcher-agent'), ReadOnlyAgentError)
    assert.throws(() => catalog.save(builtIn, options(true)), InvalidAgentError)
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

  it('um criado com o id de um embutido (arquivo antigo) não sombreia o embutido', () => {
    const repository = new NullAgentRepository()
    repository.save({ ...builtIn, name: 'impostor' }, 'x')

    assert.strictEqual(new AgentCatalog([builtIn], repository).get('researcher-agent')?.name, 'Researcher')
    assert.strictEqual(new AgentCatalog([builtIn], repository).list().length, 1)
  })
})
