import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalize, documentFromText } from './Catalog.Document'
import { forLocal, ILocalModels, localTargets } from './Connect.Policy'

const here = new Set(['claude/claude-haiku-5-5', 'openai/gpt-x'])
const models = (over: Partial<ILocalModels> = {}): ILocalModels => ({
  enabled: (provider, model) => here.has(`${provider}/${model}`),
  map: {},
  fallback: { provider: 'claude', model: 'claude-haiku-5-5' },
  ...over,
})

describe('Connect.Policy (o documento da origem aqui)', () => {
  it('o modelo que roda aqui fica; o resto vai pelo mapa e, sem mapa, para o padrão daqui', () => {
    const targets = [{ provider: 'claude', models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], sandbox: 'read-only' as never }]
    assert.deepEqual(localTargets(targets, models()), [{ provider: 'claude', models: ['claude-haiku-5-5'], sandbox: 'read-only' }])
    assert.deepEqual(localTargets(targets, models({ map: { 'claude/claude-sonnet-5-5': 'openai/gpt-x' } })), [
      { provider: 'openai', models: ['gpt-x'], sandbox: 'read-only' },
      { provider: 'claude', models: ['claude-haiku-5-5'], sandbox: 'read-only' },
    ])
    // Sem nada que rode aqui: nenhum alvo (o agente fica como veio, e o plano diz o porquê).
    assert.deepEqual(localTargets([{ provider: 'google', models: ['gemini'] }], models({ fallback: undefined })), [])
  })

  it('o agente perde o grupo de modelos e o compartilhamento da origem; o que não muda volta o mesmo', () => {
    const body = { id: 'maya', projectId: 'logiccus', providers: [{ provider: 'claude', models: ['claude-sonnet-5-5'] }], modelGroup: 'rapido', sharedWith: ['outro'] }
    const document = documentFromText('agent', 'maya', 'logiccus', canonicalize(body as never))
    const local = forLocal(document, models())
    assert.deepEqual(local.body, { id: 'maya', projectId: 'logiccus', providers: [{ provider: 'claude', models: ['claude-haiku-5-5'] }] })
    assert.notEqual(local.hash, document.hash)

    const skill = documentFromText('skill', 'banco', 'logiccus', canonicalize({ id: 'banco', body: 'x' } as never))
    assert.equal(forLocal(skill, models()), skill)
  })
})
