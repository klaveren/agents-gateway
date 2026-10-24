import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConnection } from '@domain/models/Provider.Model'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { ConfiguredTurnClassifier, resolveClassifierTarget } from './Configured.TurnClassifier'
import { TComplete } from './Llm.TurnClassifier'

const input = { request: 'hi', answer: 'hello', tools: [] }
const ON = { audience: 'all' as const, classifyTurns: true, classifierProvider: 'openai', classifierModel: 'm' }

/** Conexões em memória, `build` que anota os modelos pedidos e as chamadas, sem rede. */
function harness(
  over: {
    settings?: ConstructorParameters<typeof NullSettingsRepository>[0]
    connections?: Record<string, Partial<IProviderConnection>>
    enabled?: (providerId: string, modelId: string) => boolean
    answer?: string
  } = {},
) {
  const settings = new NullSettingsRepository(over.settings ?? { audience: 'all' })
  const connections = over.connections ?? { openai: { protocol: EProvider.OPENAI, key: 'sk-teste' } }
  const built: string[] = []
  const calls: string[] = []
  const warnings: string[] = []
  const classifier = new ConfiguredTurnClassifier({
    settings,
    prompt: 'P',
    connections: {
      connection: (id) => (connections[id] ? ({ providerId: id, name: id, protocol: EProvider.OPENAI, ...connections[id] } as IProviderConnection) : undefined),
    },
    modelEnabled: over.enabled,
    warn: (message) => warnings.push(message),
    build: (_connection, model) => {
      built.push(model)
      const complete: TComplete = async () => {
        calls.push(model)
        return over.answer ?? 'amber'
      }
      return complete
    },
  })

  return { settings, classifier, connections, built, calls, warnings }
}

describe('resolveClassifierTarget', () => {
  it('provider and model from settings, both or nothing', () => {
    assert.deepStrictEqual(resolveClassifierTarget({ audience: 'all', classifierProvider: ' openai ', classifierModel: ' m ' }), { providerId: 'openai', model: 'm' })
    assert.strictEqual(resolveClassifierTarget({ audience: 'all', classifierModel: 'm' }), undefined)
    assert.strictEqual(resolveClassifierTarget({ audience: 'all', classifierProvider: 'openai', classifierModel: '  ' }), undefined)
    assert.strictEqual(resolveClassifierTarget(undefined), undefined)
  })
})

describe('ConfiguredTurnClassifier', () => {
  it('off by default: no model call, not even a build', async () => {
    const { classifier, built, calls } = harness({ settings: { ...ON, classifyTurns: undefined } })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual([built, calls], [[], []])
  })

  it('classifyTurns false is off', async () => {
    const { classifier, calls } = harness({ settings: { ...ON, classifyTurns: false } })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual(calls, [])
  })

  it('⛔ a model without a chosen provider does not classify (no guessing by the id prefix)', async () => {
    const { classifier, calls } = harness({ settings: { audience: 'all', classifyTurns: true, classifierModel: 'gpt-5-mini' } })

    assert.strictEqual(await classifier.classify(input), undefined)
    assert.deepStrictEqual(calls, [])
  })

  it('on with the chosen provider and model', async () => {
    const { classifier, calls } = harness({ settings: ON })

    assert.strictEqual(await classifier.classify(input), 'amber')
    assert.deepStrictEqual(calls, ['m'])
  })

  it('toggling in settings takes effect on the next turn, without a restart', async () => {
    const { classifier, settings, calls } = harness()

    assert.strictEqual(await classifier.classify(input), undefined)

    await settings.save(ON)
    assert.strictEqual(await classifier.classify(input), 'amber')

    await settings.save({ ...ON, classifyTurns: false })
    assert.strictEqual(await classifier.classify(input), undefined)

    assert.strictEqual(calls.length, 1)
  })

  it('changing the model in settings switches model on the next turn, building each once', async () => {
    const { classifier, settings, calls, built } = harness({ settings: { ...ON, classifierModel: 'a' } })

    await classifier.classify(input)
    await settings.save({ ...ON, classifierModel: 'b' })
    await classifier.classify(input)
    await classifier.classify(input)

    assert.deepStrictEqual(calls, ['a', 'b', 'b'])
    assert.deepStrictEqual(built, ['a', 'b'])
  })

  it('a provider turned off, without a key, of a subscription or with the model inactive: no label, one warning each', async () => {
    const cases = [
      harness({ settings: ON, connections: {} }),
      harness({ settings: ON, connections: { openai: { key: undefined } } }),
      harness({ settings: ON, connections: { openai: { protocol: EProvider.CODEX, key: 'x' } } }),
      harness({ settings: ON, enabled: () => false }),
    ]

    for (const { classifier, warnings, calls } of cases) {
      assert.strictEqual(await classifier.classify(input), undefined)
      assert.strictEqual(await classifier.classify(input), undefined)
      assert.deepStrictEqual(calls, [])
      assert.strictEqual(warnings.length, 1)
    }
  })

  it('a new key on the screen rebuilds the client on the next turn', async () => {
    const { classifier, connections, built } = harness({ settings: ON })

    await classifier.classify(input)
    connections.openai.key = 'sk-outra'
    await classifier.classify(input)

    assert.deepStrictEqual(built, ['m', 'm'])
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
    assert.match(await harness().classifier.status(), /desligado.*classifyTurns/)
    assert.match(await harness({ settings: { audience: 'all', classifyTurns: true } }).classifier.status(), /sem provider e modelo/)
    assert.match(await harness({ settings: ON, connections: {} }).classifier.status(), /desligado: .*desligado ou não existe/)
    assert.match(await harness({ settings: ON }).classifier.status(), /ligado com o modelo m \(openai\)/)
  })
})
