import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { makePersonMessages } from '@composition/factories/PersonMessages.Factory'
import { makeImageUsage } from '@composition/factories/ImageUsage.Factory'
import { makeSpeechUsage } from '@composition/factories/SpeechUsage.Factory'
import { ISpeechEngine, SpeechService } from '@application/Speech.Service'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SqliteUserPreferenceRepository } from '@infra/persistence/Sqlite.UserPreferenceRepository'
import { HttpServer } from './Http.Server'
import { SpeechController } from './Speech.Controller'

const PASSWORD = 'frase longa o bastante'

describe('Voz (integração)', () => {
  let base = ''
  let stop = () => undefined as void
  let admin = ''
  let member = ''
  let messageId = ''
  let engine: ISpeechEngine | undefined
  let failWith: string | undefined
  const spoken: string[] = []

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const type = res.headers.get('content-type') ?? ''
    return {
      status: res.status,
      type,
      cache: res.headers.get('cache-control'),
      audio: type.startsWith('audio/') ? Buffer.from(await res.arrayBuffer()).toString() : undefined,
      body: type.includes('json') ? ((await res.json()) as { result?: any; code?: string; message?: string; details?: any }) : {}, // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const controller = makeController()
    const speech = new SpeechController({
      speech: new SpeechService({
        prefs: new SqliteUserPreferenceRepository(),
        engine: async () => engine,
        synthesize: async (_connection, _model, text) => {
          spoken.push(text)
          if (failWith) throw new Error(failWith)
          return { data: Buffer.from(`audio:${text}`), mime: 'audio/mpeg', usage: { inputTokens: 10, outputTokens: 20, characters: text.length } }
        },
        record: (entry) => makeSpeechUsage().record(entry),
      }),
      messages: makePersonMessages(),
      proof: makeAuth().proof,
    })
    const args = [controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations), ...Array<undefined>(19).fill(undefined), speech]
    const server = new HttpServer(...(args as unknown as ConstructorParameters<typeof HttpServer>)).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    const memberId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })).body.result.id
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    const now = new Date()
    await controller.conversations.saveSession({
      id: 'gw_voz_ana',
      agentId: 'zeus',
      provider: 'claude',
      mode: 'agent',
      model: 'm',
      createdAt: now,
      updatedAt: now,
      turns: 1,
      usage: {},
      metadata: { owner: { id: memberId, email: 'ana@x.test' } },
    })
    await makePersonMessages().send({ sessionId: 'gw_voz_ana', agentId: 'zeus', to: 'owner', title: 'Aviso', body: '**Pronto** para revisar.', level: 'attention' })
    messageId = (await call('/messages/gw_voz_ana', { token: member })).body.result.messages[0].id
  })

  after(() => stop())

  it('🔊 preferências: padrões, PUT parcial, validação e 401', async () => {
    engine = { connection: { providerId: 'p', protocol: EProvider.OPENAI, key: 'k' }, model: 'm', voice: 'Cherry' }
    assert.deepStrictEqual((await call('/me/voice', { token: member })).body.result, {
      enabled: false,
      rate: 1,
      minLevel: 'info',
      engine: { available: true, model: 'm', defaultVoice: 'Cherry' },
    })
    const saved = await call('/me/voice', { method: 'PUT', token: member, body: { enabled: true, rate: 1.4, minLevel: 'urgent', voice: 'Ethan' } })
    assert.deepStrictEqual(
      [saved.status, saved.body.result.enabled, saved.body.result.voice, saved.body.result.rate, saved.body.result.minLevel],
      [200, true, 'Ethan', 1.4, 'urgent'],
    )
    assert.strictEqual((await call('/me/voice', { method: 'PUT', token: member, body: { voice: null } })).body.result.voice, undefined)
    for (const body of [{ rate: 3 }, { rate: 0.1 }, { minLevel: 'x' }, { enabled: 'yes' }])
      assert.strictEqual((await call('/me/voice', { method: 'PUT', token: member, body })).status, 422)
    assert.strictEqual((await call('/me/voice')).status, 401)
    assert.strictEqual((await call('/me/voice', { method: 'PUT', body: { enabled: true } })).status, 401)
    // As preferências são de cada pessoa.
    assert.strictEqual((await call('/me/voice', { token: admin })).body.result.enabled, false)
  })

  it('🔊 áudio da mensagem: só o destinatário (404), texto sem Markdown, cache do navegador; sem motor 409; falha 502 sem a chave', async () => {
    engine = { connection: { providerId: 'p', protocol: EProvider.OPENAI, key: 'k-secret' }, model: 'm' }
    assert.strictEqual((await call(`/messages/gw_voz_ana/${messageId}/speech`, { token: admin })).status, 404)
    assert.strictEqual((await call(`/messages/gw_voz_ana/${messageId}/speech`)).status, 401)
    assert.strictEqual((await call('/messages/gw_voz_ana/m_inexistente/speech', { token: member })).status, 404)
    const heard = await call(`/messages/gw_voz_ana/${messageId}/speech`, { token: member })
    assert.deepStrictEqual([heard.status, heard.type, heard.cache, heard.audio], [200, 'audio/mpeg', 'private, no-store', 'audio:Aviso. Pronto para revisar.'])
    failWith = 'boom k-secret'
    spoken.length = 0
    const failed = await call(`/messages/gw_voz_ana/${messageId}/speech`, { token: member })
    // Cache do serviço: a mesma mensagem já foi falada, nada a sintetizar de novo.
    assert.deepStrictEqual([failed.status, spoken.length], [200, 0])
    const sample = await call('/me/voice/sample', { token: member })
    assert.deepStrictEqual([sample.status, sample.body.code], [502, 'speech_failed'])
    assert.ok(!JSON.stringify(sample.body).includes('k-secret'))
    failWith = undefined
    assert.match((await call('/me/voice/sample', { token: member })).audio ?? '', /^audio:Olá! É assim/)
    engine = undefined
    const none = await call(`/messages/gw_voz_ana/${messageId}/speech`, { token: member })
    assert.deepStrictEqual([none.status, none.body.code], [409, 'speech_unavailable'])
    assert.strictEqual((await call('/me/voice/sample', { token: member })).status, 409)
  })

  it('💰 a voz aparece na tela Uso: nos totais, por modelo e por "agente", e só a chamada ao provider conta (cache não)', async () => {
    const all = (await call('/usage/all', { token: admin })).body.result
    const voice = all.byAgent.find((item: { agentId: string }) => item.agentId === 'voice-messages')
    // O áudio da mensagem e o "Testar" foram sintetizados no provider; a segunda ouvida da mensagem veio do cache.
    assert.deepStrictEqual([voice.turns, voice.usage.inputTokens, voice.usage.outputTokens, voice.usage.totalTokens], [2, 20, 40, 60])
    const model = all.byModel.find((item: { provider: string; model: string }) => item.provider === 'p' && item.model === 'm')
    assert.strictEqual(model.usage.totalTokens, 60)
    assert.ok(all.totals.usage.totalTokens >= 60)
    const mine = (await call('/usage/me', { token: member })).body.result
    assert.strictEqual(mine.byAgent.find((item: { agentId: string }) => item.agentId === 'voice-messages').turns, 2)
    assert.strictEqual((await call('/usage/me', { token: admin })).body.result.byAgent.some((item: { agentId: string }) => item.agentId === 'voice-messages'), false)
  })

  it('🖼️ a imagem aparece na tela Uso sob o agente que a pediu, e só para a pessoa dona (mesmas linhas que o teto lê)', async () => {
    const ana = (await call('/usage/me', { token: member })).body.result
    const userId = ana.byAgent.find((item: { agentId: string }) => item.agentId === 'voice-messages') ? makeSpeechUsage().since(new Date(0))[0].userId : ''
    makeImageUsage().record({ at: new Date(), userId, agentId: 'zeus', provider: 'p', model: 'm', inputTokens: 5, outputTokens: 400, totalTokens: 405 })
    const mine = (await call('/usage/me', { token: member })).body.result
    const zeus = mine.byAgent.find((item: { agentId: string }) => item.agentId === 'zeus')
    assert.deepStrictEqual([zeus.turns, zeus.usage.inputTokens, zeus.usage.outputTokens], [1, 5, 400])
    const top = mine.top.find((item: { id: string }) => item.id === `image:${userId}`)
    assert.deepStrictEqual([top.title, top.agentId], ['Imagens', 'zeus'])
    assert.strictEqual((await call('/usage/me', { token: admin })).body.result.byAgent.some((item: { agentId: string }) => item.agentId === 'zeus'), false)
  })

  it('🔊 configurações da voz: provider e modelo juntos, provider existente com chave', async () => {
    const put = (body: unknown) => call('/settings', { method: 'PUT', token: admin, body })
    const lone = await put({ speechProvider: 'openai' })
    assert.strictEqual(lone.status, 422)
    assert.ok(lone.body.details.some((item: { field: string }) => item.field === 'speechModel'))
    const missing = await put({ speechProvider: 'nao-existe', speechModel: 'x' })
    assert.strictEqual(missing.status, 422)
    assert.ok(missing.body.details.some((item: { field: string }) => item.field === 'speechProvider'))
    const cleared = await put({ speechProvider: null, speechModel: null, speechVoice: 'Cherry' })
    assert.deepStrictEqual([cleared.status, cleared.body.result.speechVoice], [200, 'Cherry'])
    assert.strictEqual((await put({ speechVoice: null })).body.result.speechVoice, undefined)
  })
})
