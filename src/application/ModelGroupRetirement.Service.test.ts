import assert from 'node:assert'
import { describe, it } from 'node:test'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { ModelGroupRetirement } from './ModelGroupRetirement.Service'

const grupos = [
  {
    id: 'a',
    name: 'A',
    steps: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ],
    cooldownMinutes: 5,
  },
  { id: 'b', name: 'B', steps: [{ provider: 'p1', model: 'm1' }] },
  { id: 'c', name: 'C', steps: [{ provider: 'p2', model: 'm3' }] },
]

async function setup(usable: (provider: string, model: string) => boolean) {
  const settings = new NullSettingsRepository()
  await settings.save({ audience: 'all', modelGroups: structuredClone(grupos), defaultModelGroup: 'a' })
  return { settings, retirement: new ModelGroupRetirement(settings, (provider, model) => usable(provider, model)) }
}

describe('ModelGroupRetirement', () => {
  it('modelo desabilitado sai de TODAS as sequências; a que esvazia continua, vazia; o autor fica gravado', async () => {
    const { settings, retirement } = await setup((p, m) => !(p === 'p1' && m === 'm1'))
    assert.strictEqual(await retirement.retire('ana@x'), 2)
    const saved = await settings.read()
    assert.deepStrictEqual(
      saved.modelGroups?.map((g) => [g.id, g.steps.map((s) => `${s.provider}/${s.model}`)]),
      [
        ['a', ['p2/m2']],
        ['b', []],
        ['c', ['p2/m3']],
      ],
    )
    assert.strictEqual(saved.modelGroups?.[0].cooldownMinutes, 5)
    assert.strictEqual(saved.defaultModelGroup, 'a')
    assert.strictEqual(saved.updatedBy, 'ana@x')
  })

  it('provider desligado ou apagado: todos os passos dele saem', async () => {
    const { settings, retirement } = await setup((p) => p !== 'p2')
    assert.strictEqual(await retirement.retire('ana@x'), 2)
    assert.deepStrictEqual(
      (await settings.read()).modelGroups?.map((g) => g.steps.length),
      [1, 1, 0],
    )
  })

  it('boot: idempotente; nada a tirar não grava', async () => {
    const { settings, retirement } = await setup((_p, m) => m !== 'm3')
    assert.strictEqual(await retirement.retire('boot'), 1)
    const first = await settings.read()
    assert.strictEqual(await retirement.retire('boot'), 0)
    assert.deepStrictEqual(await settings.read(), first)
    const all = await setup(() => true)
    assert.strictEqual(await all.retirement.retire('boot'), 0)
    assert.strictEqual((await all.settings.read()).updatedBy, undefined, 'não gravou')
  })
})
