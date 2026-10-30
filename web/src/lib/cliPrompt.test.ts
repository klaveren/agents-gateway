import { describe, expect, it } from 'vitest'
import { CLI_ARG_MAX_BYTES, cliPromptEstimate, kib } from './cliPrompt'
import type { ICliFootprint } from './types'

const cli = (bytes: number, parts: ICliFootprint['parts']): ICliFootprint => ({
  providers: ['codex'],
  bytes,
  limit: CLI_ARG_MAX_BYTES,
  warnAt: Math.floor(CLI_ARG_MAX_BYTES * 0.8),
  parts,
})

describe('cliPromptEstimate', () => {
  const saved = { soul: 'Calmo.', systemPrompt: 'Faça X.' }
  const savedParts = [
    { key: 'soul', label: 'Soul', bytes: 50 },
    { key: 'instructions', label: 'Instrução do sistema', bytes: 8 },
    { key: 'rules', label: 'Rules', bytes: 1_000 },
    { key: 'projectSpecs', label: 'Contexto inicial do projeto', bytes: 90_000 },
  ]

  it('o medido no servidor, com o soul e a instrução da tela no lugar dos salvos', () => {
    const same = cliPromptEstimate({ cli: cli(92_000, savedParts), saved, live: saved, codex: false })
    expect(same.bytes).toBe(92_000)
    expect(same.withEnvironment).toBe(true)

    const longer = cliPromptEstimate({ cli: cli(92_000, savedParts), saved, live: { ...saved, systemPrompt: 'Faça X.' + 'a'.repeat(1_000) }, codex: false })
    expect(longer.bytes).toBe(93_000)
  })

  it('no Codex, a quebra de linha e as aspas da tela pesam o escape', () => {
    const live = { ...saved, systemPrompt: 'Faça X.\n"y"' }
    const estimate = cliPromptEstimate({ cli: cli(92_000, savedParts), saved, live, codex: true })
    expect(estimate.bytes).toBe(92_000 + '\\n\\"y\\"'.length)
  })

  it('abaixo de 80%, ok; a partir de 80%, aviso; acima do limite, passa — e diz o que pesa', () => {
    expect(cliPromptEstimate({ cli: cli(92_000, savedParts), saved, live: saved, codex: false }).level).toBe('ok')
    const warn = cliPromptEstimate({ cli: cli(Math.floor(CLI_ARG_MAX_BYTES * 0.8), savedParts), saved, live: saved, codex: false })
    expect(warn.level).toBe('warn')
    expect(warn.percent).toBe(80)
    expect(warn.heavy.map((part) => part.label)).toEqual(['Contexto inicial do projeto', 'Rules', 'Soul'])
    expect(cliPromptEstimate({ cli: cli(CLI_ARG_MAX_BYTES + 1, savedParts), saved, live: saved, codex: false }).level).toBe('over')
  })

  it('sem a medida do servidor (agente novo), só o soul e a instrução da tela', () => {
    const estimate = cliPromptEstimate({ live: { systemPrompt: 'a'.repeat(110_000) }, codex: false })
    expect(estimate.withEnvironment).toBe(false)
    expect(estimate.level).toBe('warn')
    expect(estimate.heavy).toEqual([{ label: 'Instrução do sistema', bytes: 110_000 }])
  })

  it('KiB com uma casa', () => {
    expect(kib(100_000)).toBe('97,7 KiB')
  })
})
