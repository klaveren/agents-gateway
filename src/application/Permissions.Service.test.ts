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

  it('o registro estreita por categoria e por agente ANTES do limite: a guia vê as últimas dela', () => {
    const service = make()
    service.saveProjectRules('xpto', [{ category: 'read', pattern: '**', decision: 'allow' }], 'ana')
    const log = (agentId: string, category: 'read' | 'write', value: string) => service.check({ agentId, projectId: 'xpto' }, { category, value }, { log: true })
    log('dev', 'write', 'apps/a.ts')
    for (let index = 0; index < 5; index++) log('dev', 'read', `docs/${index}.md`)
    log('qa', 'read', 'docs/qa.md')
    const subjects = (options: Parameters<typeof service.decisions>[1]) => service.decisions('xpto', options).map((entry) => entry.subject)
    assert.deepStrictEqual(subjects({ limit: 2 }), ['docs/qa.md', 'docs/4.md'])
    assert.deepStrictEqual(subjects({ category: 'write', limit: 2 }), ['apps/a.ts'], 'a escrita antiga não some atrás das leituras')
    assert.deepStrictEqual(subjects({ category: 'read', agentId: 'qa' }), ['docs/qa.md'])
    assert.deepStrictEqual(subjects({ category: 'network' }), [])
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

  it('⛔ o registro guarda o comando já mascarado (a decisão é sobre o texto cru; o segredo não vai ao banco nem à tela)', () => {
    const seen: Array<string | undefined> = []
    const service = new PermissionsService(
      new SqlitePermissionRepository(),
      () => undefined,
      () => [],
      undefined,
      (text, sessionId) => (seen.push(sessionId), text.replace(/tok-\w+/g, '[segredo]')),
    )
    service.saveProjectRules('xpto', [{ category: 'terminal', pattern: 'curl *', decision: 'allow' }], 'ana')
    const verdict = service.check({ projectId: 'xpto', sessionId: 's9' }, { category: 'terminal', value: 'curl -H "Authorization: Bearer tok-abc123" https://x' }, { log: true })
    assert.strictEqual(verdict.allowed, true)
    assert.deepStrictEqual(seen, ['s9'])
    assert.strictEqual(service.decisions('xpto')[0].subject, 'curl -H "Authorization: Bearer [segredo]" https://x')
  })
})
