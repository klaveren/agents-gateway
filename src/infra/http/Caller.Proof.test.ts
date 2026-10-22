import assert from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import { IToolResult } from '@infra/tools/Tool.Types'
import { CachedProof, ICallerProof, PROOF_MAX_ENTRIES, PROOF_TTL_MS, proofFromEnv, resetProofWarning, ToolProbeProof, warnIfProofDisabled } from './Caller.Proof'

/** Catálogo que só responde `invoke` — é a sonda que está sob teste. */
const catalogReturning = (reply: (name: string, token?: string) => IToolResult | Promise<IToolResult>) => {
  const calls: Array<{ name: string; token?: string }> = []
  return {
    calls,
    invoke: async (name: string, _args: Record<string, unknown>, context?: { token?: string }) => {
      calls.push({ name, token: context?.token })
      return reply(name, context?.token)
    },
  }
}

const ok = (payload: unknown): IToolResult => ({ status: 'success', result: JSON.stringify(payload) })

describe('ToolProbeProof', () => {
  it('gasta o token na tool configurada e aprova com `authenticated: true`', async () => {
    const catalog = catalogReturning(() => ok({ authenticated: true }))

    assert.strictEqual(await new ToolProbeProof(catalog, 'whoami').prove('tok'), true)
    assert.deepStrictEqual(catalog.calls, [{ name: 'whoami', token: 'tok' }])
  })

  it('afirmação positiva: ausente, falso, "true" em texto, e qualquer outra coisa reprovam', async () => {
    for (const payload of [{}, { authenticated: false }, { authenticated: 'true' }, { authenticated: 1 }, { ok: true }, null, [], 'true']) {
      const proof = new ToolProbeProof(
        catalogReturning(() => ok(payload)),
        'whoami',
      )
      assert.strictEqual(await proof.prove('tok'), false, JSON.stringify(payload))
    }
  })

  it('resposta ilegível, erro da tool e exceção reprovam', async () => {
    assert.strictEqual(
      await new ToolProbeProof(
        catalogReturning(() => ({ status: 'success', result: 'não é json' })),
        'whoami',
      ).prove('t'),
      false,
    )
    assert.strictEqual(
      await new ToolProbeProof(
        catalogReturning(() => ({ status: 'error', result: '{"authenticated":true}' })),
        'whoami',
      ).prove('t'),
      false,
    )
    assert.strictEqual(
      await new ToolProbeProof(
        catalogReturning(() => {
          throw new Error('rede')
        }),
        'whoami',
      ).prove('t'),
      false,
    )
  })

  it('o campo é configurável e aceita caminho com pontos', async () => {
    const catalog = catalogReturning(() => ok({ session: { valid: true } }))

    assert.strictEqual(await new ToolProbeProof(catalog, 'whoami', 'session.valid').prove('t'), true)
    assert.strictEqual(await new ToolProbeProof(catalog, 'whoami').prove('t'), false)
  })
})

describe('proofFromEnv', () => {
  it('sem CALLER_PROOF_TOOL não há prova — e não há padrão', () => {
    assert.strictEqual(
      proofFromEnv(
        catalogReturning(() => ok({})),
        {},
      ),
      undefined,
    )
    assert.strictEqual(
      proofFromEnv(
        catalogReturning(() => ok({})),
        { CALLER_PROOF_TOOL: '  ' },
      ),
      undefined,
    )
  })

  it('com a tool configurada, usa o campo padrão `authenticated`', async () => {
    const catalog = catalogReturning(() => ok({ authenticated: true }))
    const proof = proofFromEnv(catalog, { CALLER_PROOF_TOOL: 'whoami' })

    assert.strictEqual(await proof?.prove('t'), true)
    assert.strictEqual(catalog.calls[0].name, 'whoami')
  })

  it('CALLER_PROOF_FIELD troca o campo', async () => {
    const proof = proofFromEnv(
      catalogReturning(() => ok({ valid: true })),
      { CALLER_PROOF_TOOL: 'whoami', CALLER_PROOF_FIELD: 'valid' },
    )

    assert.strictEqual(await proof?.prove('t'), true)
  })
})

describe('CachedProof', () => {
  /** Estratégia contável: qualquer outra (JWKS, por exemplo) entra no mesmo lugar. */
  const counting = (decide: (token: string) => boolean = () => true) => {
    const seen: string[] = []
    const inner: ICallerProof = {
      prove: async (token) => {
        seen.push(token)
        return decide(token)
      },
    }
    return { inner, seen }
  }

  let clock = 0
  beforeEach(() => {
    clock = 1_000
  })

  it('o mesmo token dentro da janela não gasta a prova de novo', async () => {
    const { inner, seen } = counting()
    const proof = new CachedProof(inner, { now: () => clock })

    assert.strictEqual(await proof.prove('a'), true)
    clock += PROOF_TTL_MS - 1
    assert.strictEqual(await proof.prove('a'), true)
    assert.deepStrictEqual(seen, ['a'])
  })

  it('passada a janela, prova de novo', async () => {
    const { inner, seen } = counting()
    const proof = new CachedProof(inner, { now: () => clock })

    await proof.prove('a')
    clock += PROOF_TTL_MS
    await proof.prove('a')

    assert.deepStrictEqual(seen, ['a', 'a'])
  })

  it('a recusa também é memorizada', async () => {
    const { inner, seen } = counting(() => false)
    const proof = new CachedProof(inner, { now: () => clock })

    assert.strictEqual(await proof.prove('ruim'), false)
    assert.strictEqual(await proof.prove('ruim'), false)
    assert.deepStrictEqual(seen, ['ruim'])
  })

  it('erro da estratégia reprova, e a recusa fica no cache', async () => {
    let calls = 0
    const proof = new CachedProof(
      {
        prove: async () => {
          calls += 1
          throw new Error('fora do ar')
        },
      },
      { now: () => clock },
    )

    assert.strictEqual(await proof.prove('a'), false)
    assert.strictEqual(await proof.prove('a'), false)
    assert.strictEqual(calls, 1)
  })

  it('tokens diferentes têm provas independentes', async () => {
    const { inner, seen } = counting((token) => token === 'bom')
    const proof = new CachedProof(inner, { now: () => clock })

    assert.strictEqual(await proof.prove('bom'), true)
    assert.strictEqual(await proof.prove('ruim'), false)
    assert.deepStrictEqual(seen, ['bom', 'ruim'])
  })

  it('o teto é respeitado: estourou, sai a mais antiga', async () => {
    const { inner, seen } = counting()
    const proof = new CachedProof(inner, { now: () => clock })

    for (let i = 0; i < PROOF_MAX_ENTRIES + 1; i += 1) await proof.prove(`t${i}`)

    assert.strictEqual(proof.size, PROOF_MAX_ENTRIES)

    seen.length = 0
    await proof.prove('t0') // a mais antiga saiu: prova de novo
    await proof.prove(`t${PROOF_MAX_ENTRIES}`) // a mais nova segue em cache
    assert.deepStrictEqual(seen, ['t0'])
  })

  it('rajada do mesmo token compartilha uma prova só', async () => {
    let calls = 0
    const proof = new CachedProof(
      {
        prove: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 5))
          return true
        },
      },
      { now: () => clock },
    )

    assert.deepStrictEqual(await Promise.all([proof.prove('a'), proof.prove('a'), proof.prove('a')]), [true, true, true])
    assert.strictEqual(calls, 1)
  })
})

describe('warnIfProofDisabled', () => {
  beforeEach(() => resetProofWarning())

  it('avisa UMA vez quando a prova está desligada', () => {
    const logs: string[] = []
    warnIfProofDisabled(undefined, (message) => logs.push(message))
    warnIfProofDisabled(undefined, (message) => logs.push(message))

    assert.strictEqual(logs.length, 1)
    assert.match(logs[0], /CALLER_PROOF_TOOL/)
  })

  it('não avisa quando há prova', () => {
    const logs: string[] = []
    warnIfProofDisabled({ prove: async () => true }, (message) => logs.push(message))

    assert.deepStrictEqual(logs, [])
  })
})
