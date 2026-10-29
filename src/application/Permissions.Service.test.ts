import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IPermissionRule } from '@domain/Permission.Policy'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { PermissionsService } from './Permissions.Service'

const agents: Record<string, IPermissionRule[]> = { dev: [{ category: 'write', pattern: 'apps/**', decision: 'allow' }] }
const make = () =>
  new PermissionsService(
    new SqlitePermissionRepository(),
    (id) => agents[id],
    () => [{ category: 'read', pattern: '/srv/data/**', decision: 'deny' }],
  )

describe('PermissionsService', () => {
  it('projeto e agente em camadas; o registro guarda a decisão, com regra e camada', () => {
    const service = make()
    service.saveProjectRules(
      'xpto',
      [
        { category: 'read', pattern: '**', decision: 'allow' },
        { category: 'write', pattern: '**', decision: 'deny' },
      ],
      'ana',
    )
    const asker = { agentId: 'dev', projectId: 'xpto', sessionId: 's1' }
    assert.strictEqual(service.check(asker, { category: 'write', value: 'apps/web/a.ts' }, { log: true }).layer, 'agent')
    assert.strictEqual(service.check(asker, { category: 'write', value: 'infra/x.yml' }, { log: true }).allowed, false)
    assert.strictEqual(service.check(asker, { category: 'read', value: '/srv/data/gateway.db' }).layer, 'system')
    const [last, first] = service.decisions('xpto')
    assert.deepStrictEqual([last.subject, last.allowed, last.layer, last.pattern], ['infra/x.yml', false, 'project', '**'])
    assert.deepStrictEqual([first.allowed, first.layer, first.agentId], [true, 'agent', 'dev'])
    // O testador não registra.
    service.test(asker, { category: 'read', value: 'a' })
    assert.strictEqual(service.decisions('xpto').length, 2)
  })

  it('⛔ recusa regra inválida; projeto sem regra nega; apagar o projeto apaga regras e registro', () => {
    const service = make()
    assert.throws(() => service.saveProjectRules('xpto', [{ category: 'x', pattern: '', decision: 'allow' }], 'ana'), /Permissions are invalid/)
    assert.strictEqual(service.check({ projectId: 'vazio' }, { category: 'mcp', value: 'gateway/list_agents' }).layer, 'default')
    service.saveProjectRules('xpto', [{ category: 'mcp', pattern: '*', decision: 'allow' }], 'ana')
    service.check({ projectId: 'xpto' }, { category: 'mcp', value: 'a/b' }, { log: true })
    service.removeProject('xpto')
    assert.deepStrictEqual([service.projectRules('xpto').rules, service.decisions('xpto')], [[], []])
  })
})
