import assert from 'node:assert'
import { describe, it } from 'node:test'
import { cercoPlan, toSandboxPath } from './Cerco.Plan'
import { IPermissionRule } from './Permission.Policy'

const rule = (category: IPermissionRule['category'], pattern: string, decision: IPermissionRule['decision'] = 'allow'): IPermissionRule => ({ category, pattern, decision })
const base = { root: '/w/p', scratch: ['/w/p/.home', '/w/p/.tmp'], alwaysRead: ['/tools'], alwaysDeny: ['/home/gw', '/srv/data', '/w'] }

describe('Cerco.Plan', () => {
  it('padrão relativo vira absoluto na raiz; sem barra vale em qualquer pasta; absoluto e ~ ficam', () => {
    assert.strictEqual(toSandboxPath('apps/**', '/w/p'), '/w/p/apps/**')
    assert.strictEqual(toSandboxPath('*.env', '/w/p'), '/w/p/**/*.env')
    assert.strictEqual(toSandboxPath('/etc/hosts', '/w/p'), '/etc/hosts')
    assert.strictEqual(toSandboxPath('~/.ssh/key', '/w/p'), '~/.ssh/key')
  })

  it('sem regra: a raiz fechada para leitura e escrita, só as pastas de trabalho abertas; segredos sempre negados', () => {
    const plan = cercoPlan({}, base)
    assert.ok(plan.readDeny.includes('/w/p') && plan.readDeny.includes('/home/gw'))
    assert.deepStrictEqual(plan.writeAllow, ['/w/p/.home', '/w/p/.tmp'])
    assert.ok(plan.writeDeny.includes('/w/p/**/.env') && plan.readDeny.includes('/w/p/**/*.pem'))
    // A que contém a raiz fica na leitura (a raiz reabre por dentro) e sai da escrita (negar venceria tudo).
    assert.ok(plan.readDeny.includes('/w') && !plan.writeDeny.includes('/w') && plan.writeDeny.includes('/srv/data'))
  })

  it('as liberações das camadas abrem; a negação do projeto que o agente reabriu por dentro sai; a outra fica', () => {
    const plan = cercoPlan(
      {
        project: [rule('write', 'apps/**'), rule('write', 'infra/**', 'deny'), rule('write', 'secrets/**', 'deny'), rule('read', '**')],
        agent: [rule('write', 'infra/k8s/**'), rule('read', '~/.ssh/logiccus'), rule('write', 'apps/legacy/**', 'deny')],
      },
      base,
    )
    assert.ok(plan.writeAllow.includes('/w/p/apps/**') && plan.writeAllow.includes('/w/p/infra/k8s/**'))
    assert.ok(!plan.writeDeny.includes('/w/p/infra/**'), 'reaberta pelo agente')
    assert.ok(plan.writeDeny.includes('/w/p/secrets/**') && plan.writeDeny.includes('/w/p/apps/legacy/**'))
    assert.ok(plan.readAllow.includes('/w/p/**') && plan.readAllow.includes('~/.ssh/logiccus'))
  })
})
