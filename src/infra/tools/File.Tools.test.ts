import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deniedPath, makeFileTools, resolveInside } from './File.Tools'

describe('File.Tools', () => {
  let base: string
  let dir: string
  let outside: string

  const tools = () => makeFileTools({ rootFor: () => dir })
  const run = (name: string, args: Record<string, unknown>) =>
    tools()
      .find((tool) => tool.name === name)!
      .execute(args)

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'file-tools-'))
    dir = join(base, 'root')
    outside = join(base, 'outside')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    writeFileSync(join(base, 'outside.txt'), 'nope')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const foo = 1\nconst bar = 2\n')
    writeFileSync(join(dir, 'src', 'c.md'), '# foo title')
    writeFileSync(join(dir, 'node_modules', 'x', 'i.ts'), 'const foo = 9')
    writeFileSync(join(dir, '.env'), 'KEY=1')
    writeFileSync(join(dir, 'x.pem'), 'pem')
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(300 * 1024))
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    symlinkSync(outside, join(dir, 'link'))
  })

  after(() => rmSync(base, { recursive: true, force: true }))

  it('read_file numbers lines and honors offset/limit', async () => {
    const all = await run('read_file', { path: 'a.txt' })
    assert.equal(all.status, 'success')
    assert.ok(all.result.startsWith('    1\tone\n    2\ttwo'))
    const part = await run('read_file', { path: 'a.txt', offset: 2, limit: 2 })
    assert.equal(part.result.split('\n')[0], '    2\ttwo')
    assert.ok(part.result.includes('    3\tthree'))
    assert.ok(!part.result.includes('four\n'))
  })

  it('list_files matches the glob, sorted, skipping node_modules', async () => {
    const out = await run('list_files', { pattern: '**/*.ts' })
    assert.equal(out.result, 'src/b.ts')
    const sub = await run('list_files', { pattern: '*', path: 'src' })
    assert.equal(sub.result, 'src/b.ts\nsrc/c.md')
  })

  it('search_files finds regex matches with path:line', async () => {
    const out = await run('search_files', { pattern: 'const (foo|bar)' })
    assert.equal(out.status, 'success')
    assert.deepEqual(out.result.split('\n'), ['src/b.ts:1: const foo = 1', 'src/b.ts:2: const bar = 2'])
    const filtered = await run('search_files', { pattern: 'foo', glob: '**/*.md' })
    assert.equal(filtered.result, 'src/c.md:1: # foo title')
  })

  it('write_file creates parent folders', async () => {
    const out = await run('write_file', { path: 'deep/er/new.txt', content: 'hello' })
    assert.equal(out.result, 'Wrote 5 bytes to deep/er/new.txt')
    assert.equal(readFileSync(join(dir, 'deep/er/new.txt'), 'utf8'), 'hello')
  })

  it('edit_file handles unique, duplicate, replace_all, not found and identical', async () => {
    writeFileSync(join(dir, 'e.txt'), 'a b a c')
    const dup = await run('edit_file', { path: 'e.txt', old_string: 'a', new_string: 'z' })
    assert.equal(dup.status, 'error')
    assert.match(dup.result, /2 times/)
    const none = await run('edit_file', { path: 'e.txt', old_string: 'q', new_string: 'z' })
    assert.match(none.result, /not found/)
    const same = await run('edit_file', { path: 'e.txt', old_string: 'a', new_string: 'a' })
    assert.equal(same.status, 'error')
    const one = await run('edit_file', { path: 'e.txt', old_string: 'b', new_string: 'B' })
    assert.equal(one.result, 'Edited e.txt (1 replacement)')
    const all = await run('edit_file', { path: 'e.txt', old_string: 'a', new_string: 'z', replace_all: true })
    assert.equal(all.result, 'Edited e.txt (2 replacements)')
    assert.equal(readFileSync(join(dir, 'e.txt'), 'utf8'), 'z B z c')
  })

  it('refuses a path outside the root', async () => {
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      const out = await run(name, { path: '../outside.txt', content: 'x', old_string: 'n', new_string: 'm' })
      assert.equal(out.status, 'error')
      assert.match(out.result, /outside the allowed folder/)
    }
    assert.equal(readFileSync(join(base, 'outside.txt'), 'utf8'), 'nope')
  })

  it('refuses a symlink pointing outside the root', async () => {
    const read = await run('read_file', { path: 'link/secret.txt' })
    assert.match(read.result, /outside the allowed folder/)
    const write = await run('write_file', { path: 'link/new.txt', content: 'x' })
    assert.match(write.result, /outside the allowed folder/)
    assert.equal(resolveInside(dir, 'link'), undefined)
  })

  it('refuses protected files for read and write', async () => {
    for (const path of ['.env', 'x.pem']) {
      const read = await run('read_file', { path })
      assert.match(read.result, /this file is protected/)
      const write = await run('write_file', { path, content: 'x' })
      assert.match(write.result, /this file is protected/)
    }
    const listed = await run('list_files', { pattern: '*' })
    assert.ok(!listed.result.includes('.env') && !listed.result.includes('x.pem'))
    assert.ok(deniedPath(join(dir, 'secrets.json'), dir))
    assert.ok(deniedPath(join(dir, 'id_rsa.pub'), dir))
    assert.equal(deniedPath(join(dir, 'a.txt'), dir), undefined)
  })

  it('refuses a large file without offset/limit, reads it with them', async () => {
    const whole = await run('read_file', { path: 'big.txt' })
    assert.equal(whole.status, 'error')
    assert.match(whole.result, /256 KB/)
    const part = await run('read_file', { path: 'big.txt', offset: 1, limit: 1 })
    assert.equal(part.status, 'success')
  })

  it('refuses a binary file', async () => {
    const out = await run('read_file', { path: 'bin.dat' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /binary/)
  })

  it('⛔ as permissões valem por arquivo: leitura negada recusa, a listagem e a busca escondem; escrita só onde a regra deixa', async () => {
    const decide = (kind: 'read' | 'write', path: string) =>
      kind === 'read' ? (path.startsWith('src/') || path === 'src' || path === '.' ? undefined : 'negado') : path.startsWith('src/') ? undefined : 'negado'
    const asked: string[] = []
    const guarded = makeFileTools({ rootFor: () => dir, access: (_context, kind, path, log) => (log && asked.push(`${kind}:${path}`), decide(kind, path)) })
    const call = (name: string, args: Record<string, unknown>) => guarded.find((tool) => tool.name === name)!.execute(args)

    assert.match((await call('read_file', { path: 'a.txt' })).result, /Not permitted: negado/)
    assert.strictEqual((await call('read_file', { path: 'src/b.ts' })).status, 'success')
    const listed = (await call('list_files', { pattern: '**/*' })).result
    assert.ok(listed.includes('src/b.ts') && !listed.includes('a.txt'), listed)
    const found = (await call('search_files', { pattern: 'foo|one' })).result
    assert.ok(found.includes('src/b.ts') && !found.includes('a.txt'), found)
    assert.match((await call('write_file', { path: 'novo.txt', content: 'x' })).result, /Not permitted/)
    assert.strictEqual((await call('write_file', { path: 'src/novo.txt', content: 'x' })).status, 'success')
    // Só o arquivo pedido é registrado, não cada item de uma listagem.
    assert.deepStrictEqual(asked, ['read:a.txt', 'read:src/b.ts', 'write:novo.txt', 'write:src/novo.txt'])
  })
})
