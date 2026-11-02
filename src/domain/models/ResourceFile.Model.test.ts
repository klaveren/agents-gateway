import assert from 'node:assert'
import { describe, it } from 'node:test'
import { fileIssues, filePathIssue, filesNote, RESOURCE_FILE_MAX_BYTES, sortFiles } from './ResourceFile.Model'

const sha = (char: string) => char.repeat(64)

describe('ResourceFile.Model — os arquivos de um recurso', () => {
  it('o caminho: relativo, com "/", sem "..", sem .git, sem espaço', () => {
    assert.deepStrictEqual(['scripts/run.mjs', 'a.txt', 'dados/x_1-2.json'].map(filePathIssue), [undefined, undefined, undefined])
    for (const bad of ['', '/etc/passwd', '../fora', 'a/../b', 'a//b', 'com espaço.sh', '.git/config', 'a/./b']) assert.ok(filePathIssue(bad), bad)
  })

  it('a lista: forma, caminho repetido, arquivo que também é pasta e os tetos', () => {
    const ok = { path: 'scripts/a.sh', sha256: sha('a'), bytes: 10 }
    assert.deepStrictEqual(fileIssues([ok]), [])
    assert.deepStrictEqual(fileIssues(undefined), [])
    const fields = (files: unknown) => fileIssues(files).map((issue) => issue.field)
    assert.deepStrictEqual(fields([ok, ok]), ['files[1].path'])
    assert.deepStrictEqual(fields([{ ...ok, sha256: 'x' }]), ['files[0].sha256'])
    assert.deepStrictEqual(fields([{ ...ok, bytes: RESOURCE_FILE_MAX_BYTES + 1 }]), ['files[0].bytes'])
    assert.match(fileIssues([{ ...ok, path: 'scripts' }, ok])[0].message, /scripts is both a file and a folder/)
    assert.deepStrictEqual(fields('x'), ['files'])
  })

  it('a ordem canônica é a do caminho; a nota diz a pasta e lista os arquivos', () => {
    const files = [
      { path: 'b.sh', sha256: sha('b'), bytes: 2 },
      { path: 'a.sh', sha256: sha('a'), bytes: 1 },
    ]
    assert.deepStrictEqual(
      sortFiles(files).map((file) => file.path),
      ['a.sh', 'b.sh'],
    )
    const note = filesNote('/d/global/skills/x', files, 'da skill x')
    assert.match(note, /Pasta \(só leitura\): \/d\/global\/skills\/x/)
    assert.match(note, /- a\.sh \(1 bytes\)\n- b\.sh/)
    assert.strictEqual(filesNote('/d', [], 'x'), '')
  })
})
