import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('AgentHooksService — assinaturas já vistas', () => {
  it('⛔ a mesma assinatura só passa uma vez na janela, vence depois dela e sobrevive ao restart (SQLite)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-seen-'))
    const path = join(dir, 'hooks.db')
    const build = () => new AgentHooksService(new SqliteAgentHookRepository(path), new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'), () => true)
    try {
      const first = build()
      assert.strictEqual(first.claimSignature('a', 'h', 'sig', 1_000, 300_000), true)
      assert.strictEqual(first.claimSignature('a', 'h', 'sig', 2_000, 300_000), false)
      assert.strictEqual(first.claimSignature('a', 'outro', 'sig', 2_000, 300_000), true, 'por hook')
      // Restart: um serviço novo sobre o mesmo arquivo ainda recusa o reenvio.
      assert.strictEqual(build().claimSignature('a', 'h', 'sig', 3_000, 300_000), false)
      assert.strictEqual(build().claimSignature('a', 'h', 'sig', 400_000, 300_000), true, 'vencida (TTL de 5 min)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requireTimestamp: padrão desligado, grava e edita', () => {
    const service = new AgentHooksService(new SqliteAgentHookRepository(':memory:'), new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'), () => true)
    const by = { userId: 'u', label: 'u' }
    assert.strictEqual(service.create('a', { name: 'um', prompt: 'p', verify: 'hmac' }, by).hook.requireTimestamp, false)
    assert.strictEqual(service.create('a', { name: 'dois', prompt: 'p', verify: 'hmac', requireTimestamp: true }, by).hook.requireTimestamp, true)
    assert.strictEqual(service.update('a', 'um', { requireTimestamp: true }, 'u').requireTimestamp, true)
    assert.strictEqual(service.get('a', 'um').requireTimestamp, true)
  })
})
