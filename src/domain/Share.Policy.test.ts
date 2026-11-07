import assert from 'node:assert'
import { describe, it } from 'node:test'
import { reaches, runsUnder, shareIssues, sharedInto } from './Share.Policy'

describe('Share.Policy — o agente compartilhado', () => {
  const exists = (id: string) => ['alfa', 'beta'].includes(id)
  const agent = { projectId: 'alfa', sharedWith: ['beta'] }

  it('agente de projeto se compartilha com outro projeto que existe; o global e o próprio projeto não', () => {
    assert.deepStrictEqual(shareIssues({ kind: 'agent', projectId: 'alfa' }, ['beta'], exists), [])
    assert.strictEqual(shareIssues({ kind: 'agent' }, ['beta'], exists).length, 1)
    assert.strictEqual(shareIssues({ kind: 'agent', projectId: 'alfa' }, ['alfa'], exists).length, 1)
    assert.strictEqual(shareIssues({ kind: 'agent', projectId: 'alfa' }, ['longe'], exists).length, 1)
    assert.strictEqual(shareIssues({ kind: 'rule', projectId: 'alfa' }, ['beta'], exists).length, 1)
  })

  it('⛔ a conversa de outro projeto roda a parte de projeto do agente como o global; na origem, como sempre', () => {
    assert.strictEqual(runsUnder(agent, 'beta'), undefined)
    assert.strictEqual(runsUnder(agent, 'alfa'), 'alfa')
    assert.strictEqual(runsUnder(agent, undefined), 'alfa')
    assert.strictEqual(runsUnder({}, 'beta'), undefined)
  })

  it('⛔ o projeto da conversa alcança o agente só se é o dele, se é global ou se foi compartilhado com ele', () => {
    assert.ok(reaches(agent, 'alfa') && reaches(agent, 'beta') && reaches(agent, undefined) && reaches({}, 'gama'))
    assert.ok(!reaches(agent, 'gama'))
    assert.ok(!reaches({ projectId: 'alfa' }, 'beta'))
    assert.ok(sharedInto(agent, 'beta') && !sharedInto(agent, 'alfa') && !sharedInto(agent, 'gama'))
  })
})
