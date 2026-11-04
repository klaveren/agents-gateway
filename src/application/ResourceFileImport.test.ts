import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { importRepositoryFiles, mergeFiles } from './ResourceFileImport'

describe('ResourceFileImport', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-import-files-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  const skill = join(root, 'repositories', 'logiccus', '.agents', 'skills', 'efi')
  mkdirSync(join(skill, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(skill, 'scripts', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(skill, 'scripts', 'balance.mjs'), 'console.log(process.env.EFI_CLIENT_ID ? "ok" : "falta")\n')
  writeFileSync(join(skill, 'scripts', 'lib', 'creds.mjs'), 'export const id = process.env.EFI_CLIENT_ID\n')
  writeFileSync(join(skill, 'scripts', 'node_modules', 'x', 'index.js'), 'x')
  writeFileSync(join(skill, 'scripts', '.env'), 'EFI_CLIENT_SECRET=valor\n')
  writeFileSync(join(skill, 'scripts', '.env.example'), 'EFI_CLIENT_SECRET=\n')
  writeFileSync(join(skill, 'scripts', 'token.txt'), 'glpat-AAAAAAAAAAAAAAAAAAAA\n')
  writeFileSync(join(skill, 'scripts', 'cert.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(root, 'fora.txt'), 'fora')
  symlinkSync(join(root, 'fora.txt'), join(skill, 'scripts', 'atalho.txt'))

  const stored: Buffer[] = []
  const files = { put: (content: Buffer) => (stored.push(content), { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length }) }
  const secretsIn = (text: string) => (text.includes('glpat-') ? ['token GitLab'] : [])

  it('⛔ o gateway copia a pasta: entram os scripts; ficam de fora node_modules, .env, segredo, binário e atalho, com o motivo', () => {
    const result = importRepositoryFiles(root, 'repositories/logiccus/.agents/skills/efi/scripts', 'scripts', { files, secretsIn })
    assert.deepStrictEqual(
      result.added.map((file) => file.path),
      ['scripts/.env.example', 'scripts/balance.mjs', 'scripts/lib/creds.mjs'],
    )
    const reasons = Object.fromEntries(result.skipped.map((item) => [item.path.split('/').pop(), item.reason]))
    assert.match(reasons['.env'], /secret variable/)
    assert.match(reasons['token.txt'], /has a secret \(token GitLab\)/)
    assert.match(reasons['cert.bin'], /binary/)
    assert.match(reasons['atalho.txt'], /symbolic link/)
    assert.match(reasons.node_modules, /not part of a resource/)
    assert.ok(!stored.some((content) => content.toString().includes('glpat-')), 'o arquivo com segredo nem chega ao depósito')
  })

  it('um arquivo só entra pelo nome; caminho fora da pasta do projeto ou que não existe é recusado', () => {
    assert.deepStrictEqual(
      importRepositoryFiles(root, 'repositories/logiccus/.agents/skills/efi/scripts/balance.mjs', 'scripts', { files }).added.map((file) => file.path),
      ['scripts/balance.mjs'],
    )
    assert.throws(() => importRepositoryFiles(join(root, 'repositories'), '../fora.txt', '', { files }), /outside the project folder/)
    assert.throws(() => importRepositoryFiles(root, 'nao/existe', '', { files }), /not found/)
  })

  it('a lista nova soma por cima (mesmo caminho troca) e `remove` tira caminhos e pastas', () => {
    const file = (path: string, sha = 'a') => ({ path, sha256: sha.repeat(64), bytes: 1 })
    assert.deepStrictEqual(
      mergeFiles([file('scripts/a.mjs'), file('scripts/old/x.mjs'), file('README.md')], [file('scripts/a.mjs', 'b'), file('scripts/c.mjs')], ['scripts/old']).map((item) => [
        item.path,
        item.sha256[0],
      ]),
      [
        ['README.md', 'a'],
        ['scripts/a.mjs', 'b'],
        ['scripts/c.mjs', 'a'],
      ],
    )
  })
})
