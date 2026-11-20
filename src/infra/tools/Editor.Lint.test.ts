import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { lintRepositoryFile, parseEslintJson } from './Editor.Lint'

describe('Editor.Lint — o ESLint do repositório no editor da tela', () => {
  let root: string
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-lint-'))
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\n')
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
    writeFileSync(join(root, 'b.py'), 'x = 1\n')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('lê o JSON do eslint (com o stderr junto) e o arquivo ignorado', () => {
    const out = `aviso qualquer\n[{"messages":[{"line":1,"column":7,"endLine":1,"endColumn":8,"severity":2,"message":"'a' is assigned a value but never used.","ruleId":"no-unused-vars"}]}]`
    assert.deepEqual(parseEslintJson(out), [
      { line: 1, column: 7, endLine: 1, endColumn: 8, severity: 2, message: "'a' is assigned a value but never used.", ruleId: 'no-unused-vars' },
    ])
    assert.equal(parseEslintJson('[{"messages":[{"message":"File ignored because of a matching ignore pattern.","severity":1}]}]'), 'ignored')
    assert.equal(parseEslintJson('Oops! Something went wrong!'), undefined)
  })

  it('roda o eslint do pacote, no cerco, sobre o arquivo', async () => {
    const lines: string[] = []
    const result = await lintRepositoryFile(root, 'a.ts', async (line, cwd) => {
      lines.push(`${line} @ ${cwd}`)
      return { code: 1, timedOut: false, output: '[{"messages":[{"line":1,"column":7,"severity":1,"message":"warn","ruleId":"x"}]}]' }
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.messages[0].severity, 1)
    assert.match(lines[0], /node_modules\/\.bin\/eslint' --format json '.*a\.ts' @ /)
  })

  it('sem cerco não roda; tipo sem ESLint fica de fora; sem eslint no repositório avisa', async () => {
    assert.equal((await lintRepositoryFile(root, 'a.ts', undefined)).status, 'unavailable')
    assert.equal((await lintRepositoryFile(root, 'b.py', async () => ({ code: 0, timedOut: false, output: '' }))).status, 'ignored')
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    assert.equal((await lintRepositoryFile(root, 'a.ts', async () => ({ code: 0, timedOut: false, output: '[]' }))).status, 'unavailable')
  })
})
