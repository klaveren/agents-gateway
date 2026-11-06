import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { AgentHooksService } from './AgentHooks.Service'

describe('AgentHooksService — o runAs', () => {
  const build = () => new AgentHooksService(new SqliteAgentHookRepository(':memory:'), new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'), () => true)
  const seed = () => {
    const service = build()
    service.create('agente', { name: 'deploy', prompt: 'original', session: 'continuous' }, { userId: 'u_a', label: 'a' })
    return service
  }

  it('⛔ quem edita o hook de OUTRA pessoa assume o runAs, e a conversa contínua dela não segue; só desligar não assume', () => {
    const service = seed()
    service.setSession('agente', 'deploy', 'conv-do-a')
    assert.strictEqual(service.update('agente', 'deploy', { enabled: false }, 'b', 'u_b').runAs, 'u_a')
    const taken = service.update('agente', 'deploy', { prompt: 'do B' }, 'b', 'u_b')
    assert.deepStrictEqual([taken.runAs, taken.sessionId], ['u_b', undefined])
    assert.strictEqual(service.update('agente', 'deploy', { prompt: 'do B 2' }, 'a', 'u_a').runAs, 'u_a')
  })

  it('⛔ quem troca a chave de OUTRA pessoa assume o runAs; o dono trocando, não muda nada', () => {
    const service = seed()
    service.rotate('agente', 'deploy', 'a', 'u_a')
    assert.strictEqual(service.get('agente', 'deploy').runAs, 'u_a')
    service.rotate('agente', 'deploy', 'b', 'u_b')
    assert.strictEqual(service.get('agente', 'deploy').runAs, 'u_b')
  })
})
