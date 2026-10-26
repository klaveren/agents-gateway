/**
 * GUARD — ausente, com valor e nulo são TRÊS casos, não dois.
 *
 * Enquanto ausente e nulo eram a mesma coisa, escolher um modelo era porta de mão única: dava para
 * trocar por outro, nunca para voltar ao padrão.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidSettingsError } from '@domain/errors/Domain.Error'
import { allowsCaller, AUDIENCES, DEFAULT_SETTINGS, IAudienceCaller, IAudienceRules, mergeSettings, normalizeSettings, TAudience } from './Settings.Model'

describe('mergeSettings', () => {
  const gravado = { ...DEFAULT_SETTINGS, agentId: 'pesquisa-teste', model: 'gemini-3.7-flash', classifierModel: 'c-1' }

  it('campo ausente não mexe no que está gravado', () => {
    const next = mergeSettings(gravado, { audience: 'restricted' })

    assert.equal(next.audience, 'restricted')
    assert.equal(next.model, 'gemini-3.7-flash')
    assert.equal(next.agentId, 'pesquisa-teste')
  })

  it('campo com valor troca', () => {
    assert.equal(mergeSettings(gravado, { model: 'gemini-3.6-flash' }).model, 'gemini-3.6-flash')
  })

  it('null apaga: a chave some, não vira nula', () => {
    const next = mergeSettings(gravado, { model: null })

    assert.equal(next.model, undefined)
    assert.equal('model' in next, false)
  })

  it('texto vazio também apaga — é o que um select em branco manda', () => {
    const next = mergeSettings(gravado, { agentId: '', classifierModel: '' })

    assert.equal('agentId' in next, false)
    assert.equal('classifierModel' in next, false)
    assert.equal(next.model, 'gemini-3.7-flash')
  })

  it('apaga também o booleano opcional', () => {
    assert.equal('classifyTurns' in mergeSettings({ ...gravado, classifyTurns: true }, { classifyTurns: null }), false)
  })

  it('campo obrigatório não aceita null nem vazio', () => {
    assert.throws(() => mergeSettings(gravado, { audience: null } as never), InvalidSettingsError)
    assert.throws(() => mergeSettings(gravado, { audience: '' } as never), InvalidSettingsError)
  })

  it('carimba quem alterou e quando; sem identificação não grava a chave', () => {
    const named = mergeSettings(gravado, {}, 'root@x.test')
    assert.equal(named.updatedBy, 'root@x.test')
    assert.ok(named.updatedAt instanceof Date)

    assert.equal('updatedBy' in mergeSettings(gravado, {}), false)
  })

  it('não altera o objeto de entrada', () => {
    const copia = { ...gravado }
    mergeSettings(gravado, { model: null, audience: 'off' })

    assert.deepEqual(gravado, copia)
  })
})

describe('normalizeSettings — migração de `enabled`', () => {
  it('enabled: false vira off', () => {
    assert.equal(normalizeSettings({ enabled: false }).audience, 'off')
  })

  it('enabled: true ou ausente cai no padrão, que é aberto', () => {
    assert.equal(DEFAULT_SETTINGS.audience, 'all')
    assert.equal(normalizeSettings({ enabled: true }).audience, 'all')
    assert.equal(normalizeSettings({}).audience, 'all')
  })

  it('audience gravado ganha de enabled, e `enabled` não sobrevive', () => {
    const settings = normalizeSettings({ enabled: true, audience: 'restricted', model: 'm' })

    assert.equal(settings.audience, 'restricted')
    assert.equal('enabled' in settings, false)
    assert.equal(normalizeSettings({ enabled: false, audience: 'all' }).audience, 'all')
  })

  it('lixo vira padrão e campo de tipo errado é descartado, sem lançar', () => {
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings('x'), DEFAULT_SETTINGS)

    const settings = normalizeSettings({ audience: 'superuser', model: 42, agentId: '  ', classifyTurns: 'yes', updatedAt: 'ontem', updatedBy: 'a@x.test' })
    assert.deepEqual(settings, { audience: 'all', updatedBy: 'a@x.test' })
  })

  it('devolve a data como Date', () => {
    assert.ok(normalizeSettings({ updatedAt: '2026-10-22T12:00:00.000Z' }).updatedAt instanceof Date)
  })
})

describe('allowsCaller — matriz de audiência', () => {
  const rules = (over: Partial<IAudienceRules> = {}): IAudienceRules => ({ audienceRoles: ['admin'], deniedRoles: [], requireProven: true, ...over })

  const provenAdmin: IAudienceCaller = { identified: true, proven: true, role: 'admin' }
  const provenUser: IAudienceCaller = { identified: true, proven: true, role: 'member' }
  const provenNoRole: IAudienceCaller = { identified: true, proven: true }
  const claimedAdmin: IAudienceCaller = { identified: true, proven: false, role: 'admin' }
  const claimedUser: IAudienceCaller = { identified: true, proven: false, role: 'member' }
  const anonymous: IAudienceCaller = { identified: false, proven: false }

  it('off recusa todos', () => {
    for (const caller of [provenAdmin, provenUser, claimedAdmin, anonymous]) assert.equal(allowsCaller('off', caller, rules()), false)
  })

  it('restricted: só o papel da lista, e só provado', () => {
    assert.equal(allowsCaller('restricted', provenAdmin, rules()), true)
    assert.equal(allowsCaller('restricted', provenUser, rules()), false)
    assert.equal(allowsCaller('restricted', provenNoRole, rules()), false)
    assert.equal(allowsCaller('restricted', anonymous, rules()), false)
  })

  it('restricted: papel afirmado e não provado nunca abre — nem com a exigência de dono desligada', () => {
    assert.equal(allowsCaller('restricted', claimedAdmin, rules()), false)
    assert.equal(allowsCaller('restricted', claimedAdmin, rules({ requireProven: false })), false)
  })

  it('restricted: a lista é configurável e a comparação ignora caixa', () => {
    assert.equal(allowsCaller('restricted', { ...provenUser, role: 'Member' }, rules({ audienceRoles: ['member', 'ops'] })), true)
    assert.equal(allowsCaller('restricted', provenAdmin, rules({ audienceRoles: ['member'] })), false)
  })

  it('all: admite o provado, com ou sem papel', () => {
    for (const caller of [provenAdmin, provenUser, provenNoRole]) assert.equal(allowsCaller('all', caller, rules()), true)
  })

  it('all: identidade só afirmada entra só quando a exigência de dono foi desligada', () => {
    assert.equal(allowsCaller('all', claimedUser, rules()), false)
    assert.equal(allowsCaller('all', claimedUser, rules({ requireProven: false })), true)
  })

  it('all: a chamada anônima entra (só existe com ALLOW_ANONYMOUS)', () => {
    assert.equal(allowsCaller('all', anonymous, rules()), true)
  })

  it('papel recusado vence tudo, `all` incluído, provado ou não', () => {
    const denied = rules({ deniedRoles: ['member', 'admin'] })

    for (const audience of AUDIENCES) {
      for (const caller of [provenAdmin, provenUser, claimedAdmin, claimedUser]) {
        assert.equal(allowsCaller(audience, caller, denied), false, `${audience} ${caller.role} ${caller.proven}`)
      }
    }
  })

  it('papel recusado não atinge os outros papéis, nem quem não tem papel', () => {
    const denied = rules({ deniedRoles: ['member'] })

    assert.equal(allowsCaller('all', provenAdmin, denied), true)
    assert.equal(allowsCaller('all', provenNoRole, denied), true)
    assert.equal(allowsCaller('restricted', provenAdmin, denied), true)
  })

  it('valor de audiência desconhecido fecha', () => {
    assert.equal(allowsCaller('superuser' as TAudience, provenAdmin, rules()), false)
  })
})
