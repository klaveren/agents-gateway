import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SqliteUserPreferenceRepository } from '@infra/persistence/Sqlite.UserPreferenceRepository'
import { ISpeechEngine, SpeechFailedError, SpeechService, SpeechUnavailableError, speechEngineOf } from './Speech.Service'

const ENGINE: ISpeechEngine = { connection: { providerId: 'p', protocol: EProvider.OPENAI, key: 'k-secret' }, model: 'm', voice: 'Cherry' }

function build(engine: ISpeechEngine | null = ENGINE, fail?: string) {
  const calls: Array<{ text: string; voice?: string; rate: number }> = []
  const service = new SpeechService({
    prefs: new SqliteUserPreferenceRepository(),
    engine: async () => engine ?? undefined,
    synthesize: async (_connection, _model, text, options) => {
      calls.push({ text, ...options })
      if (fail) throw new Error(fail)
      return { data: Buffer.from(`audio:${text}`), mime: 'audio/mpeg' }
    },
  })
  return { service, calls }
}

describe('SpeechService', () => {
  it('padrões, salvar parcial e voz nula', async () => {
    const { service } = build()
    assert.deepStrictEqual(await service.view('u1'), { enabled: false, rate: 1, minLevel: 'info', engine: { available: true, model: 'm', defaultVoice: 'Cherry' } })
    await service.save('u1', { enabled: true, voice: 'Ethan', rate: 1.5 })
    const saved = await service.save('u1', { minLevel: 'urgent' })
    assert.deepStrictEqual([saved.enabled, saved.voice, saved.rate, saved.minLevel], [true, 'Ethan', 1.5, 'urgent'])
    assert.strictEqual((await service.save('u1', { voice: null })).voice, undefined)
    assert.strictEqual((await service.view('u2')).enabled, false)
  })

  it('🎙️ vozes da conta no motor: só as do modelo do motor (ou sem modelo conhecido)', async () => {
    const service = new SpeechService({
      prefs: new SqliteUserPreferenceRepository(),
      engine: async () => ENGINE,
      synthesize: async () => ({ data: Buffer.from('x'), mime: 'audio/mpeg' }),
      accountVoices: (providerId) => (providerId === 'p' ? [{ id: 'a', model: 'm' }, { id: 'b', model: 'outro' }, { id: 'c' }] : []),
    })
    assert.deepStrictEqual((await service.view('u')).engine.voices, ['a', 'c'])
  })

  it('sem motor: indisponível; erro do motor sai sem a chave', async () => {
    await assert.rejects(build(null).service.speak('u', 'oi'), SpeechUnavailableError)
    assert.strictEqual((await build(null).service.view('u')).engine.available, false)
    await assert.rejects(build(ENGINE, 'boom k-secret').service.speak('u', 'oi'), (error: Error) => error instanceof SpeechFailedError && !error.message.includes('k-secret'))
  })

  it('cache: o mesmo texto, voz e velocidade não sintetiza de novo; outra velocidade sim', async () => {
    const { service, calls } = build()
    await service.speak('u', 'oi')
    await service.speak('u', 'oi')
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].voice, 'Cherry')
    await service.save('u', { rate: 2, voice: 'Ethan' })
    await service.speak('u', 'oi')
    assert.deepStrictEqual([calls.length, calls[1].voice, calls[1].rate], [2, 'Ethan', 2])
  })

  it('o cache guarda no máximo 50 áudios', async () => {
    const { service, calls } = build()
    for (let index = 0; index < 60; index++) await service.speak('u', `t${index}`)
    await service.speak('u', 't59')
    assert.strictEqual(calls.length, 60)
    await service.speak('u', 't0')
    assert.strictEqual(calls.length, 61)
  })

  it('speechEngineOf exige provider, modelo e chave', () => {
    const connection = () => ENGINE.connection
    assert.strictEqual(speechEngineOf({ audience: 'all', speechProvider: 'p' }, connection), undefined)
    assert.strictEqual(
      speechEngineOf({ audience: 'all', speechProvider: 'p', speechModel: 'm' }, () => ({ protocol: EProvider.OPENAI })),
      undefined,
    )
    assert.deepStrictEqual(speechEngineOf({ audience: 'all', speechProvider: 'p', speechModel: 'm', speechVoice: 'v' }, connection)?.voice, 'v')
  })
})
