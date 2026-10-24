import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { InvalidModelError } from '@domain/errors/Domain.Error'
import { SqliteModelCatalogRepository } from '@infra/persistence/Sqlite.ModelCatalogRepository'
import { ModelCatalogService } from './ModelCatalog.Service'

const DEFAULTS = { 'claude-sonnet-5': { input: 3, output: 15 } }

describe('ModelCatalogService', () => {
  const build = () => new ModelCatalogService(new SqliteModelCatalogRepository(), DEFAULTS, (id) => id === 'claude')

  it('sincronizar traz os novos DESLIGADOS, com o preço da listagem ou o de fábrica (só no oficial)', () => {
    const catalog = build()

    const result = catalog.sync('claude', [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }, { id: 'claude-novo' }], 'root')
    const [compat] = (catalog.sync('agregador', [{ id: 'claude-sonnet-5', price: { input: 4, output: 20 } }], 'root'), catalog.list('agregador'))

    assert.deepStrictEqual(result, { added: 2, updated: 0, missing: 0, total: 2 })
    assert.ok(catalog.list('claude').every((model) => !model.enabled))
    assert.deepStrictEqual(
      catalog.list('claude').map((model) => [model.modelId, model.priceSource]),
      [
        ['claude-novo', undefined],
        ['claude-sonnet-5', 'default'],
      ],
    )
    // O mesmo id num compatível NÃO herda o preço de fábrica: vale o que a listagem dele disse.
    assert.deepStrictEqual([compat.price, compat.priceSource], [{ input: 4, output: 20 }, 'catalog'])
  })

  it('o raciocínio da listagem é gravado; sincronização sem o dado não apaga o que se sabia', () => {
    const catalog = build()
    catalog.sync('claude', [{ id: 'claude-sonnet-5', reasoning: { supported: true, levels: ['low', 'high'], source: 'provider' } }], 'root')
    catalog.sync('claude', [{ id: 'claude-sonnet-5' }], 'root')

    assert.deepStrictEqual(catalog.reasoningOf('claude', 'claude-sonnet-5'), { supported: true, levels: ['low', 'high'], source: 'provider' })
    assert.strictEqual(catalog.reasoningOf('claude', 'nao-existe'), undefined)
  })

  it('um banco anterior à coluna `reasoning` ganha a coluna e mantém as linhas', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'catalog-')), 'old.db')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE provider_models (provider_id TEXT NOT NULL, model_id TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1, context_length INTEGER, price TEXT, price_source TEXT, synced_at TEXT, updated_at TEXT NOT NULL,
      updated_by TEXT, PRIMARY KEY (provider_id, model_id))`)
    old.prepare("INSERT INTO provider_models (provider_id, model_id, enabled, updated_at) VALUES ('claude', 'antigo', 1, ?)").run(new Date().toISOString())
    old.close()

    const catalog = new ModelCatalogService(new SqliteModelCatalogRepository(path), DEFAULTS, () => true)
    catalog.sync('claude', [{ id: 'antigo', reasoning: { supported: false, source: 'provider' } }], 'root')

    assert.deepStrictEqual(
      catalog.list('claude').map((model) => [model.modelId, model.enabled, model.reasoning?.supported]),
      [['antigo', true, false]],
    )
  })

  it('⚖️ a nova sincronização preserva ativação e preço manual, e marca (sem apagar) o que sumiu', () => {
    const catalog = build()
    catalog.sync('agregador', [{ id: 'a', price: { input: 1, output: 2 } }, { id: 'b' }], 'root')
    catalog.setEnabled('agregador', 'a', true, 'root')
    catalog.setPrice('agregador', 'a', { input: 9, output: 9 }, 'root')

    const result = catalog.sync('agregador', [{ id: 'a', price: { input: 1, output: 3 } }], 'root')
    const [a, b] = catalog.list('agregador')

    assert.deepStrictEqual(result, { added: 0, updated: 1, missing: 1, total: 1 })
    assert.deepStrictEqual([a.modelId, a.enabled, a.price, a.priceSource], ['a', true, { input: 9, output: 9 }, 'manual'])
    assert.deepStrictEqual([b.modelId, b.available], ['b', false])
  })

  it('apagar o preço manual volta ao de fábrica; preço absurdo é recusado', () => {
    const catalog = build()
    catalog.sync('claude', [{ id: 'claude-sonnet-5' }], 'root')
    catalog.setPrice('claude', 'claude-sonnet-5', { input: 1, output: 1 }, 'root')

    assert.deepStrictEqual(catalog.setPrice('claude', 'claude-sonnet-5', null, 'root').price, { input: 3, output: 15 })
    assert.throws(() => catalog.setPrice('claude', 'claude-sonnet-5', { input: -1, output: 1 }, 'root'), InvalidModelError)
  })

  it('o que um agente já usa entra ativado; quem foi desligado não é religado', () => {
    const catalog = build()
    catalog.ensureEnabled('claude', 'claude-sonnet-5', 'seed')
    assert.deepStrictEqual(catalog.enabledIds('claude'), ['claude-sonnet-5'])

    catalog.setEnabled('claude', 'claude-sonnet-5', false, 'root')
    catalog.ensureEnabled('claude', 'claude-sonnet-5', 'seed')
    assert.deepStrictEqual(catalog.enabledIds('claude'), [])
  })

  it('⛔ os preços de um provider vêm SÓ do catálogo: a fábrica é sugestão ao acrescentar, nunca uma segunda fonte', () => {
    const catalog = build()
    catalog.sync('agregador', [{ id: 'x/y', price: { input: 1, output: 2 } }], 'root')

    assert.deepStrictEqual(catalog.pricing('claude'), {})
    catalog.addModel('claude', 'claude-sonnet-5', 'root')
    assert.deepStrictEqual(catalog.pricing('claude'), { 'claude-sonnet-5': DEFAULTS['claude-sonnet-5'] })
    assert.deepStrictEqual(catalog.pricing('agregador'), { 'x/y': { input: 1, output: 2 } })
  })

  it('⛔ utilizável = ativado E disponível: modelo que sumiu da listagem deixa de valer', () => {
    const catalog = build()
    catalog.sync('agregador', [{ id: 'a' }, { id: 'b' }], 'root')
    catalog.setEnabled('agregador', 'a', true, 'root')
    catalog.setEnabled('agregador', 'b', true, 'root')
    catalog.sync('agregador', [{ id: 'a' }], 'root')

    assert.deepStrictEqual(catalog.enabledIds('agregador'), ['a'])
    assert.strictEqual(catalog.isEnabled('agregador', 'b'), false)
  })
})
