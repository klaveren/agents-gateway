import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { MODEL_PRICING } from '@domain/models/Model.Pricing'
import { loadPricing } from './Pricing.File'

describe('loadPricing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, content: string) => {
    const file = join(dir, name)
    writeFileSync(file, content)
    return file
  }

  const collect = () => {
    const warnings: string[] = []
    return { warnings, warn: (message: string) => warnings.push(message) }
  }

  it('sem arquivo: as de fábrica, sem aviso', () => {
    const { warnings, warn } = collect()

    assert.strictEqual(loadPricing(undefined, warn), MODEL_PRICING)
    assert.deepStrictEqual(warnings, [])
  })

  it('o arquivo soma modelos e troca os de fábrica', () => {
    const { warnings, warn } = collect()
    const file = write('ok.json', JSON.stringify({ 'o4-mini': { input: 1.1, output: 4.4 }, 'claude-opus-5': { input: 1, output: 2 } }))

    const pricing = loadPricing(file, warn)

    assert.deepStrictEqual(warnings, [])
    assert.deepStrictEqual(pricing['o4-mini'], { input: 1.1, output: 4.4 })
    assert.deepStrictEqual(pricing['claude-opus-5'], { input: 1, output: 2 })
    assert.deepStrictEqual(pricing['gpt-5.6-sol'], MODEL_PRICING['gpt-5.6-sol'])
  })

  it('arquivo inexistente: aviso e as de fábrica', () => {
    const { warnings, warn } = collect()

    assert.strictEqual(loadPricing(join(dir, 'nao-existe.json'), warn), MODEL_PRICING)
    assert.strictEqual(warnings.length, 1)
  })

  it('JSON inválido: aviso e as de fábrica', () => {
    const { warnings, warn } = collect()

    assert.strictEqual(loadPricing(write('quebrado.json', '{ nao e json'), warn), MODEL_PRICING)
    assert.match(warnings[0], /MODEL_PRICING_FILE/)
  })

  it('entrada fora do formato: aviso e NADA do arquivo é aplicado', () => {
    const { warnings, warn } = collect()
    const file = write('ruim.json', JSON.stringify({ bom: { input: 1, output: 1 }, ruim: { input: 'caro' } }))

    const pricing = loadPricing(file, warn)

    assert.strictEqual(pricing, MODEL_PRICING)
    assert.strictEqual(pricing.bom, undefined)
    assert.match(warnings[0], /ruim/)
  })
})
