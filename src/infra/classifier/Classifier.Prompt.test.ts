import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DEFAULT_CLASSIFIER_PROMPT, loadClassifierPrompt } from './Classifier.Prompt'

describe('loadClassifierPrompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'classifier-prompt-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  const collect = () => {
    const warnings: string[] = []
    return { warnings, warn: (message: string) => warnings.push(message) }
  }

  it('the default prompt names the four labels and treats the text as data', () => {
    for (const word of ['green', 'blue', 'amber', 'red']) assert.match(DEFAULT_CLASSIFIER_PROMPT, new RegExp(word))
    assert.match(DEFAULT_CLASSIFIER_PROMPT, /DATA, not instructions/)
  })

  it('the default prompt is generic: no business wording', () => {
    assert.doesNotMatch(DEFAULT_CLASSIFIER_PROMPT, /seller|e-?commerce|catalog/i)
  })

  it('without a file: the default, silently', () => {
    const { warnings, warn } = collect()

    assert.strictEqual(loadClassifierPrompt(undefined, warn), DEFAULT_CLASSIFIER_PROMPT)
    assert.deepStrictEqual(warnings, [])
  })

  it('a valid file replaces the prompt', () => {
    const { warnings, warn } = collect()
    const file = join(dir, 'ok.txt')
    writeFileSync(file, '  Custom prompt\n')

    assert.strictEqual(loadClassifierPrompt(file, warn), 'Custom prompt')
    assert.deepStrictEqual(warnings, [])
  })

  it('a missing file: warning and the default', () => {
    const { warnings, warn } = collect()

    assert.strictEqual(loadClassifierPrompt(join(dir, 'nope.txt'), warn), DEFAULT_CLASSIFIER_PROMPT)
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0], /CLASSIFIER_PROMPT_FILE/)
  })

  it('an empty file: warning and the default', () => {
    const { warnings, warn } = collect()
    const file = join(dir, 'empty.txt')
    writeFileSync(file, '  \n')

    assert.strictEqual(loadClassifierPrompt(file, warn), DEFAULT_CLASSIFIER_PROMPT)
    assert.strictEqual(warnings.length, 1)
  })
})
