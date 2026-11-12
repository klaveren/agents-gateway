import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentLocalLayer } from '@domain/models/AgentLocalLayer.Model'
import { SqliteAgentLocalLayerRepository } from './Sqlite.AgentLocalLayerRepository'

const layer = (agentId: string, extra: Partial<IAgentLocalLayer> = {}): IAgentLocalLayer => ({
  agentId,
  allowedTools: ['mcp:local/*'],
  permissions: [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }],
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
  updatedBy: 'dev',
  ...extra,
})

describe('camadas locais (sqlite)', () => {
  it('grava, troca, apaga e volta igual depois de reabrir o arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layers-'))
    try {
      const path = join(dir, 'gateway.db')
      const repository = new SqliteAgentLocalLayerRepository(path)
      repository.save(layer('sre'))
      repository.save(layer('sre', { providers: [{ provider: EProvider.CLAUDE, models: ['claude-haiku-5'] }], allowedTools: ['agent:ajudante'], disabledTools: ['mcp:tickets/*'] }))
      repository.save(layer('theo'))
      repository.remove('theo')
      assert.equal(repository.get('theo'), undefined)

      const reopened = new SqliteAgentLocalLayerRepository(path)
      assert.deepEqual(
        reopened.list().map((item) => item.agentId),
        ['sre'],
      )
      assert.deepEqual(
        reopened.get('sre'),
        layer('sre', { providers: [{ provider: EProvider.CLAUDE, models: ['claude-haiku-5'] }], allowedTools: ['agent:ajudante'], disabledTools: ['mcp:tickets/*'] }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sem modelos locais e sem nada desligado, os campos nem existem', () => {
    const repository = new SqliteAgentLocalLayerRepository()
    repository.save(layer('sre'))
    assert.ok(!('providers' in repository.get('sre')!))
    assert.ok(!('disabledTools' in repository.get('sre')!))
  })
})
