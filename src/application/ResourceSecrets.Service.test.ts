import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { InvalidGuidanceError } from '@domain/errors/Domain.Error'
import type { IKnownSecret } from '@domain/Secret.Mask'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { ResourceSecretsService } from './ResourceSecrets.Service'

describe('ResourceSecretsService', () => {
  function setup() {
    const masked: Array<{ sessionId: string; secrets: readonly IKnownSecret[] }> = []
    const exists = new Set(['agent:theo', 'skill:gitlab', 'command:deploy'])
    const service = new ResourceSecretsService({
      store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
      exists: (scope, id) => exists.has(`${scope}:${id}`),
      mask: { register: (sessionId, secrets) => masked.push({ sessionId, secrets }) },
    })
    return { service, masked }
  }

  it('grava com o valor; recusa nome inválido, recurso que não existe, valor vazio e variável nova sem valor', () => {
    const { service } = setup()
    const saved = service.save('agent', 'theo', { name: 'API_TOKEN', value: 'tok-1234567890' }, 'root')
    assert.deepStrictEqual([saved.name, 'value' in saved], ['API_TOKEN', false])
    for (const [scope, id, input] of [
      ['agent', 'theo', { name: 'minusculo', value: 'x'.repeat(10) }],
      ['skill', 'nao-existe', { name: 'TOKEN', value: 'x'.repeat(10) }],
      ['agent', 'theo', { name: 'API_TOKEN', value: '  ' }],
      ['agent', 'theo', { name: 'NOVA' }],
    ] as const)
      assert.throws(() => service.save(scope, id, input, 'root'), InvalidGuidanceError, JSON.stringify(input))
  })

  it('⚖️ a do agente vale sempre; a da skill e a do command só depois de carregados NA conversa', () => {
    const { service, masked } = setup()
    service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'do-agente-123' }, 'root')
    service.save('skill', 'gitlab', { name: 'GITLAB_TOKEN', value: 'glpat-da-skill' }, 'root')
    service.save('command', 'deploy', { name: 'GITLAB_TOKEN', value: 'glpat-do-command' }, 'root')
    assert.deepStrictEqual(service.envFor('theo', 'c1').env, { AGENTE_TOKEN: 'do-agente-123' })

    service.markLoaded('c1', 'skill', 'gitlab')
    assert.deepStrictEqual(service.envFor('theo', 'c1').env, { AGENTE_TOKEN: 'do-agente-123', GITLAB_TOKEN: 'glpat-da-skill' })
    // Outra conversa não carregou nada.
    assert.deepStrictEqual(service.envFor('theo', 'c2').env, { AGENTE_TOKEN: 'do-agente-123' })
    // O command vence a skill.
    service.markLoaded('c1', 'command', 'deploy')
    assert.strictEqual(service.envFor('theo', 'c1').env.GITLAB_TOKEN, 'glpat-do-command')

    // ⛔ O que foi entregue entra na máscara da conversa, com o nome como rótulo.
    assert.ok(masked.some((entry) => entry.sessionId === 'c1' && entry.secrets.some((secret) => secret.label === 'GITLAB_TOKEN' && secret.value === 'glpat-do-command')))
  })

  it('o prompt recebe só os nomes: os do agente e os dos recursos que ele pode carregar', () => {
    const { service } = setup()
    service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'do-agente-123' }, 'root')
    service.save('skill', 'gitlab', { name: 'GITLAB_TOKEN', value: 'glpat-da-skill' }, 'root')
    const ambient = service.ambientFor('theo', [
      { kind: 'skill', id: 'gitlab' },
      { kind: 'command', id: 'deploy' },
    ])
    assert.deepStrictEqual(ambient, { agent: ['AGENTE_TOKEN'], resources: [{ kind: 'skill', id: 'gitlab', names: ['GITLAB_TOKEN'] }] })
    assert.ok(!JSON.stringify(ambient).includes('glpat'))
    assert.strictEqual(setup().service.ambientFor('theo', []), undefined)
  })
})
