import assert from 'node:assert'
import { describe, it } from 'node:test'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { ConfiguredTurnClassifier, resolveClassifierModel } from './Configured.TurnClassifier'
import { TComplete } from './Llm.TurnClassifier'

const input = { request: 'hi', answer: 'hello', tools: [] }

/** `build` que anota os modelos pedidos e as chamadas, sem rede. */
function harness(over: { settings?: ConstructorParameters<typeof NullSettingsRepository>[0]; envModel?: string; answer?: string; buildable?: boolean } = {}) {
  const settings = new NullSettingsRepository(over.settings ?? { audience: 'all' })
  const built: string[] = []
  const calls: string[] = []
  const warnings: string[] = []
  const classifier = new ConfiguredTurnClassifier({
    settings,
    prompt: 'P',
    envModel: over.envModel,
    warn: (message) => warnings.push(message),
    build: (model) => {
      built.push(model)
      if (over.buildable === false) return undefined
      const complete: TComplete = async () => {
        calls.push(model)
        return over.answer ?? 'amber'
      }
      return complete
    },
  })

  return { settings, classifier, built, calls, warnings }
}

describe('resolveClassifierModel', () => {
  it('settings first, then CLASSIFIER_MODEL, then nothing', () => {
    assert.strictEqual(resolveClassifierModel({ audience: 'all', classifierModel: 'from-settings' }, 'from-env'), 'from-settings')
    assert.strictEqual(resolveClassifierModel({ audience: 'all' }, 'from-env'), 'from-env')
    assert.strictEqual(resolveClassifierModel({ audience: 'all', classifierModel: '  ' }, ' from-env '), 'from-env')
    assert.strictEqual(resolveClassifierModel({ audience: 'all' }, undefined), undefined)
    assert.strictEqual(resolveClassifierModel(undefined, ''), undefined)
  })
})

describe('ConfiguredTurnClassifier', () => {
  it('off by default: no model call, not even a build', async () => {
    const { classifier, built, calls } = harness({ envModel: 'm' })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual([built, calls], [[], []])
  })

  it('classifyTurns false is off', async () => {
    const { classifier, calls } = harness({ settings: { audience: 'all', classifyTurns: false }, envModel: 'm' })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual(calls, [])
  })

  it('on without any model: no call', async () => {
    const { classifier, calls } = harness({ settings: { audience: 'all', classifyTurns: true } })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual(calls, [])
  })

  it('on with the environment model', async () => {
    const { classifier, calls } = harness({ settings: { audience: 'all', classifyTurns: true }, envModel: 'env-model' })

    assert.strictEqual(await classifier.classify(input), 'amber')
    assert.deepStrictEqual(calls, ['env-model'])
  })

  it('the settings model wins over the environment', async () => {
    const { classifier, calls } = harness({ settings: { audience: 'all', classifyTurns: true, classifierModel: 'ui-model' }, envModel: 'env-model' })

    await classifier.classify(input)

    assert.deepStrictEqual(calls, ['ui-model'])
  })

  it('toggling in settings takes effect on the next turn, without a restart', async () => {
    const { classifier, settings, calls } = harness({ envModel: 'm' })

    assert.strictEqual(await classifier.classify(input), undefined)

    await settings.save({ audience: 'all', classifyTurns: true })
    assert.strictEqual(await classifier.classify(input), 'amber')

    await settings.save({ audience: 'all', classifyTurns: false })
    assert.strictEqual(await classifier.classify(input), undefined)

    assert.strictEqual(calls.length, 1)
  })

  it('changing the model in settings switches model on the next turn, building each once', async () => {
    const { classifier, settings, calls, built } = harness({ settings: { audience: 'all', classifyTurns: true, classifierModel: 'a' } })

    await classifier.classify(input)
    await settings.save({ audience: 'all', classifyTurns: true, classifierModel: 'b' })
    await classifier.classify(input)
    await classifier.classify(input)

    assert.deepStrictEqual(calls, ['a', 'b', 'b'])
    assert.deepStrictEqual(built, ['a', 'b'])
  })

  it('a model that cannot be built (no key, unknown provider): no label, one warning', async () => {
    const { classifier, warnings, calls } = harness({ settings: { audience: 'all', classifyTurns: true }, envModel: 'm', buildable: false })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(warnings.length, 1)
  })

  it('never throws when the settings cannot be read', async () => {
    const original = console.warn
    console.warn = () => {}
    try {
      const classifier = new ConfiguredTurnClassifier({
        settings: {
          read: async () => {
            throw new Error('db down')
          },
          save: async () => {},
          subscribe: () => {},
        },
        prompt: 'P',
      })

      assert.strictEqual(await classifier.classify(input), undefined)
    } finally {
      console.warn = original
    }
  })

  it('the boot line says why it is off, or that it is on', async () => {
    assert.match(await harness({ envModel: 'm' }).classifier.status(), /desligado.*classifyTurns/)
    assert.match(await harness({ settings: { audience: 'all', classifyTurns: true } }).classifier.status(), /sem modelo/)
    assert.match(await harness({ settings: { audience: 'all', classifyTurns: true }, envModel: 'm', buildable: false }).classifier.status(), /desligado: .*provider|chave/)
    assert.match(await harness({ settings: { audience: 'all', classifyTurns: true }, envModel: 'm' }).classifier.status(), /ligado com o modelo m/)
  })
})
