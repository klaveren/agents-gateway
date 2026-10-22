import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { ownerOf, ownsSession, provenCaller, requireProvenOwner, resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'

const approving: ICallerProof = { prove: async () => true }
const denying: ICallerProof = { prove: async () => false }

describe('requireProvenOwner', () => {
  afterEach(() => delete process.env.REQUIRE_PROVEN_OWNER)

  it('o padrão é exigir prova; só um valor explícito de "não" desliga', () => {
    assert.strictEqual(requireProvenOwner(), true)
    for (const value of ['1', 'true', '', 'qualquer coisa']) {
      process.env.REQUIRE_PROVEN_OWNER = value
      assert.strictEqual(requireProvenOwner(), true, value)
    }
    for (const value of ['0', 'false', 'OFF', 'no']) {
      process.env.REQUIRE_PROVEN_OWNER = value
      assert.strictEqual(requireProvenOwner(), false, value)
    }
  })
})

describe('provenCaller', () => {
  it('só devolve a identidade quando a prova confirma', async () => {
    const identity = { token: 't', id: 'u1' }

    assert.deepStrictEqual(await withCaller(identity, () => provenCaller(approving)), identity)
    assert.strictEqual(await withCaller(identity, () => provenCaller(denying)), undefined)
  })

  it('prova desligada: nada é provado, e o gateway recusa o que exige prova', async () => {
    assert.strictEqual(await withCaller({ token: 't', id: 'u1' }, () => provenCaller(undefined)), undefined)
  })

  it('sem token ou sem id, não há o que provar', async () => {
    assert.strictEqual(await provenCaller(approving), undefined)
    assert.strictEqual(await withCaller({ token: 't' }, () => provenCaller(approving)), undefined)
  })
})

describe('resolveCaller', () => {
  afterEach(() => delete process.env.REQUIRE_PROVEN_OWNER)

  it('sem credencial é anônimo', async () => {
    assert.deepStrictEqual(await resolveCaller(undefined), { proven: false })
    assert.deepStrictEqual(await withCaller({}, () => resolveCaller(approving)), { proven: false })
  })

  it('com prova: aprovada passa como provada, recusada é negada', async () => {
    const identity = { token: 't', id: 'u1' }

    assert.deepStrictEqual(await withCaller(identity, () => resolveCaller(approving)), { identity, proven: true })
    assert.strictEqual(await withCaller(identity, () => resolveCaller(denying)), undefined)
  })

  it('sem prova, por padrão: credencial é recusada', async () => {
    assert.strictEqual(await withCaller({ token: 't', id: 'u1' }, () => resolveCaller(undefined)), undefined)
  })

  it('sem prova, REQUIRE_PROVEN_OWNER=0: passa como afirmada (não provada)', async () => {
    process.env.REQUIRE_PROVEN_OWNER = '0'
    const identity = { token: 't', id: 'u1' }

    assert.deepStrictEqual(await withCaller(identity, () => resolveCaller(undefined)), { identity, proven: false })
  })

  it('credencial sem id NUNCA vira anônimo, com ou sem prova', async () => {
    process.env.REQUIRE_PROVEN_OWNER = '0'

    assert.strictEqual(await withCaller({ token: 't' }, () => resolveCaller(undefined)), undefined)
    assert.strictEqual(await withCaller({ token: 't' }, () => resolveCaller(approving)), undefined)
  })
})

describe('ownerOf / ownsSession', () => {
  const alice = { proven: true, identity: { id: 'alice', email: 'a@x.test', account: 'acc-1' } }

  it('o dono carrega id, e email e conta quando existem', () => {
    assert.deepStrictEqual(ownerOf(alice), { id: 'alice', email: 'a@x.test', account: 'acc-1' })
    assert.deepStrictEqual(ownerOf({ proven: true, identity: { id: 'bob' } }), { id: 'bob' })
    assert.strictEqual(ownerOf({ proven: false }), undefined)
  })

  it('só o dono, na mesma conta, é dono', () => {
    const metadata = { owner: { id: 'alice', account: 'acc-1' } }

    assert.strictEqual(ownsSession(alice, metadata), true)
    assert.strictEqual(ownsSession({ proven: true, identity: { id: 'bob', account: 'acc-1' } }, metadata), false)
    assert.strictEqual(ownsSession({ proven: true, identity: { id: 'alice', account: 'acc-2' } }, metadata), false)
    assert.strictEqual(ownsSession({ proven: true, identity: { id: 'alice' } }, metadata), false)
  })

  it('sessão sem conta serve a qualquer conta do mesmo usuário', () => {
    assert.strictEqual(ownsSession(alice, { owner: { id: 'alice' } }), true)
  })

  it('escopos separados: o anônimo só vê o sem dono, e o identificado nunca vê o sem dono', () => {
    assert.strictEqual(ownsSession({ proven: false }, undefined), true)
    assert.strictEqual(ownsSession({ proven: false }, {}), true)
    assert.strictEqual(ownsSession({ proven: false }, { owner: { id: 'alice' } }), false)
    assert.strictEqual(ownsSession(alice, undefined), false)
    assert.strictEqual(ownsSession(alice, { owner: 'alice' }), false)
  })
})
