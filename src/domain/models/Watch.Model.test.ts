import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IWatch, clipWatchOutput, wakeInput, watchLine, watchMaxActive, watchMinWakeMinutes, watchNotice, watchSpan, watchStartInput } from './Watch.Model'

const base: IWatch = {
  id: 'w-1',
  sessionId: 's',
  agentId: 'a',
  runAs: 'u',
  kind: 'command',
  label: 'servidor voltar',
  command: 'curl -sf http://x/health',
  everySeconds: 60,
  then: 'avisar que voltou',
  status: 'met',
  createdAt: new Date('2026-01-01T10:00:00Z'),
  deadlineAt: new Date('2026-01-01T11:00:00Z'),
  endedAt: new Date('2026-01-01T10:05:00Z'),
  checks: 5,
  failures: 0,
  lastOutput: 'ok',
  delivered: false,
  deliveryAttempts: 0,
}

describe('Watch.Model', () => {
  it('confere os argumentos do watch_start e aplica os padrões', () => {
    const ok = watchStartInput({ label: ' x ', command: 'test -f a', then: 'seguir' })
    assert.deepStrictEqual(ok, { value: { label: 'x', command: 'test -f a', everySeconds: 60, deadlineMinutes: 60, then: 'seguir' } })
    const bad = watchStartInput({ label: '', command: '', then: '', everySeconds: 5, deadlineMinutes: 99999 })
    assert.ok('issues' in bad)
    assert.strictEqual(bad.issues.length, 5)
    const never = watchStartInput({ label: 'x', command: 'c', then: 't', everySeconds: 600, deadlineMinutes: 5 })
    assert.ok('issues' in never && never.issues[0].includes('nunca conferiria'))
  })

  it('o wake_me tem piso e teto', () => {
    assert.ok('issues' in wakeInput({ label: 'x', then: 't', afterMinutes: 1 }, 5))
    assert.ok('issues' in wakeInput({ label: 'x', then: 't', afterMinutes: 7 * 24 * 60 + 1 }, 5))
    assert.ok('issues' in wakeInput({ label: 'x', then: 't' }, 5))
    assert.deepStrictEqual(wakeInput({ label: 'x', then: 't', afterMinutes: 30 }, 5), { value: { label: 'x', afterMinutes: 30, then: 't' } })
    assert.ok('value' in wakeInput({ label: 'x', then: 't', afterMinutes: 0.1 }, 0.05))
  })

  it('os tetos vêm do ambiente, com padrão', () => {
    assert.strictEqual(watchMaxActive({}), 50)
    assert.strictEqual(watchMaxActive({ WATCH_MAX_ACTIVE: '3' }), 3)
    assert.strictEqual(watchMaxActive({ WATCH_MAX_ACTIVE: 'x' }), 50)
    assert.strictEqual(watchMinWakeMinutes({}), 5)
    assert.strictEqual(watchMinWakeMinutes({ WATCH_MIN_WAKE_MINUTES: '0.1' }), 0.1)
  })

  it('corta a saída pelo fim', () => {
    assert.strictEqual(clipWatchOutput('  ok \n'), 'ok')
    const cut = clipWatchOutput(`${'a'.repeat(3000)}FIM`)
    assert.strictEqual(cut.length, 2001)
    assert.ok(cut.startsWith('…') && cut.endsWith('FIM'))
  })

  it('escreve a duração', () => {
    assert.strictEqual(watchSpan(40_000), '40 s')
    assert.strictEqual(watchSpan(5 * 60_000), '5 min')
    assert.strictEqual(watchSpan(125 * 60_000), '2 h 5 min')
    assert.strictEqual(watchSpan(2 * 60 * 60_000), '2 h')
    assert.strictEqual(watchSpan(3 * 24 * 60 * 60_000), '3 dias')
  })

  it('o aviso diz que não é a pessoa, o que houve, a saída e o que o agente anotou', () => {
    const met = watchNotice(base, new Date('2026-01-01T10:05:00Z'))
    assert.ok(met.startsWith('[Aviso do gateway, não é mensagem da pessoa: a vigia "servidor voltar"'))
    assert.ok(met.includes('disparou') && met.includes('5 min') && met.includes('5 conferências'))
    assert.ok(met.includes('Comando conferido: curl -sf http://x/health'))
    assert.ok(met.includes('Saída da última conferência:\nok'))
    assert.ok(met.includes('O que você anotou para fazer agora: avisar que voltou'))

    const expired = watchNotice({ ...base, status: 'expired', endedAt: base.deadlineAt }, base.deadlineAt)
    assert.ok(expired.includes('SEM a condição acontecer') && !expired.includes('atraso'))
    const failed = watchNotice({ ...base, status: 'failed', endReason: 'a conferência não rodou 5 vezes seguidas' }, base.deadlineAt)
    assert.ok(failed.includes('parou: a conferência não rodou 5 vezes seguidas'))
  })

  it('o aviso que sai atrasado diz que atrasou', () => {
    const timer: IWatch = { ...base, kind: 'timer', command: undefined, lastOutput: undefined, endedAt: new Date('2026-01-01T11:30:00Z') }
    const late = watchNotice(timer, new Date('2026-01-01T11:30:00Z'))
    assert.ok(late.includes('chegou a hora de "servidor voltar"') && late.includes('30 min de atraso'))
    assert.ok(!late.includes('Comando conferido'))
    assert.ok(!watchNotice({ ...timer, endedAt: timer.deadlineAt }, new Date('2026-01-01T11:00:05Z')).includes('atraso'))
    assert.ok(watchNotice({ ...base, status: 'expired' }, new Date('2026-01-01T12:00:00Z')).includes('1 h de atraso'))
  })

  it('a linha da lista mostra o estado', () => {
    const now = new Date('2026-01-01T10:10:00Z')
    assert.strictEqual(watchLine({ ...base, status: 'active' }, now), 'w-1 · servidor voltar · confere a cada 60 s · prazo em 50 min · 5 conferência(s)')
    assert.strictEqual(watchLine({ ...base, status: 'active', kind: 'timer' }, now), 'w-1 · servidor voltar · acorda em 50 min')
    assert.strictEqual(watchLine({ ...base, status: 'cancelled', endReason: 'cancelada' }, now), 'w-1 · servidor voltar · cancelada (cancelada)')
  })
})
