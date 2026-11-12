import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('⛔ search_files: a regex de retrocesso exponencial não para o gateway; a busca acaba com o aviso', async () => {
    writeFileSync(join(dir, 'src', 'redos.txt'), `${'a'.repeat(40)}b\n`)
    const started = Date.now()
    const out = await run('search_files', { pattern: '(a+)+$', path: 'src' })
    assert.equal(out.status, 'error')
    assert.match(out.result, /too slow/)
    assert.ok(Date.now() - started < 10_000)
    rmSync(join(dir, 'src', 'redos.txt'))
    assert.match((await run('search_files', { pattern: 'x'.repeat(1001) })).result, /too long/)
  })

  it('⛔ edit_file: o resultado também tem teto (replace_all não multiplica o arquivo)', async () => {
    writeFileSync(join(dir, 'muitos.txt'), 'a'.repeat(100 * 1024))
    const out = await run('edit_file', { path: 'muitos.txt', old_string: 'a', new_string: 'b'.repeat(100), replace_all: true })
    assert.equal(out.status, 'error')
    assert.match(out.result, /larger than 5 MB/)
    assert.equal(statSync(join(dir, 'muitos.txt')).size, 100 * 1024)
    rmSync(join(dir, 'muitos.txt'))
  })

  it('⛔ list_files/search_files: o padrão não sai da pasta pedida (absoluto ou com `..` nem começa a varrer)', async () => {
    for (const pattern of ['../*', 'sub/../../*', '/etc/host*']) {
      const listed = await run('list_files', { pattern })
      assert.equal(listed.status, 'error', pattern)
      assert.match(listed.result, /must be relative/)
      const searched = await run('search_files', { pattern: 'localhost', glob: pattern })
      assert.equal(searched.status, 'error', pattern)
      assert.match(searched.result, /must be relative/)
    }
    // Um nome com dois pontos no meio continua valendo.
    writeFileSync(join(dir, 'a..b.txt'), 'x')
    assert.match((await run('list_files', { pattern: 'a..b.*' })).result, /a\.\.b\.txt/)
    rmSync(join(dir, 'a..b.txt'))
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
    // ⛔ No disco do Mac `.ENV` é o `.env` e `.GIT/config` é o `.git/config`.
    for (const path of ['.ENV', '.Env.local', 'X.PEM', '.GIT/config', 'sub/.Git/hooks/pre-commit', '.HOME/.Accounts/x']) assert.ok(deniedPath(join(dir, path), dir), path)
    assert.match((await run('read_file', { path: '.ENV' })).result, /this file is protected/)
    assert.match((await run('write_file', { path: '.GIT/config', content: 'x' })).result, /protected/)
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

describe('File.Tools — ⛔ as pastas de arquivos de recurso são só leitura', () => {
  let data: string
  let root: string
  const before_ = process.env.CONVERSATIONS_DB
  before(() => {
    data = mkdtempSync(join(tmpdir(), 'file-tools-res-'))
    root = join(data, 'projects', 'alfa')
    mkdirSync(join(root, 'skills', 'banco'), { recursive: true })
    writeFileSync(join(root, 'skills', 'banco', 'run.sh'), 'echo oi')
    process.env.CONVERSATIONS_DB = join(data, 'gateway.db')
  })
  after(() => {
    if (before_ === undefined) delete process.env.CONVERSATIONS_DB
    else process.env.CONVERSATIONS_DB = before_
    rmSync(data, { recursive: true, force: true })
  })
  const run = (name: string, args: Record<string, unknown>) =>
    makeFileTools({ rootFor: () => root })
      .find((tool) => tool.name === name)!
      .execute(args)

  it('lê, mas não grava nem edita; fora delas grava como sempre', async () => {
    assert.strictEqual((await run('read_file', { path: 'skills/banco/run.sh' })).status, 'success')
    const write = await run('write_file', { path: 'skills/banco/run.sh', content: 'rm -rf /' })
    assert.deepStrictEqual([write.status, /read-only/.test(String(write.result))], ['error', true])
    const edit = await run('edit_file', { path: 'skills/banco/run.sh', old_string: 'oi', new_string: 'tchau' })
    assert.strictEqual(edit.status, 'error')
    assert.strictEqual((await run('write_file', { path: 'agents/maya/novo.txt', content: 'x' })).status, 'error')
    assert.strictEqual((await run('write_file', { path: 'notas/a.md', content: 'x' })).status, 'success')
  })
})

describe('File.Tools — ⛔ a pasta privada do agente', () => {
  let data: string
  let root: string
  let mine: string
  let other: string
  const before_ = process.env.CONVERSATIONS_DB
  before(() => {
    data = mkdtempSync(join(tmpdir(), 'file-tools-own-'))
    root = join(data, 'projects', 'alfa')
    mine = join(data, 'global', 'agents', 'atlas')
    other = join(root, 'agents', 'leo')
    for (const dir of [root, mine, other]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(mine, 'notas.md'), 'minha')
    writeFileSync(join(other, 'segredo.md'), 'dele')
    process.env.CONVERSATIONS_DB = join(data, 'gateway.db')
  })
  after(() => {
    if (before_ === undefined) delete process.env.CONVERSATIONS_DB
    else process.env.CONVERSATIONS_DB = before_
    rmSync(data, { recursive: true, force: true })
  })
  // ⛔ Sem regra nenhuma liberando: a própria pasta vale pela capacidade; o resto segue a regra (aqui, tudo negado).
  const tools = (access: { read: boolean; write: boolean }) => makeFileTools({ rootFor: () => root, ownFolder: () => ({ dir: mine, ...access }), access: () => 'sem regra' })
  const run = (access: { read: boolean; write: boolean }, name: string, args: Record<string, unknown>) =>
    tools(access)
      .find((tool) => tool.name === name)!
      .execute(args)

  it('lê e grava a própria pasta pelo caminho absoluto, sem regra; mostra o caminho absoluto', async () => {
    const read = await run({ read: true, write: true }, 'read_file', { path: join(mine, 'notas.md') })
    assert.equal(read.status, 'success')
    const wrote = await run({ read: true, write: true }, 'write_file', { path: join(mine, 'dados', 'a.json'), content: '{}' })
    assert.deepEqual([wrote.status, String(wrote.result).endsWith(join('atlas', 'dados', 'a.json'))], ['success', true])
    const listed = await run({ read: true, write: true }, 'list_files', { pattern: '**/*', path: mine })
    const real = realpathSync(mine)
    assert.deepEqual(String(listed.result).split('\n').sort(), [join(real, 'dados'), join(real, 'dados', 'a.json'), join(real, 'notas.md')])
  })

  it('⛔ sem Escrever arquivos, a própria pasta é só leitura', async () => {
    assert.equal((await run({ read: true, write: false }, 'read_file', { path: join(mine, 'notas.md') })).status, 'success')
    const wrote = await run({ read: true, write: false }, 'write_file', { path: join(mine, 'b.md'), content: 'x' })
    assert.deepEqual([wrote.status, /read-only for you/.test(String(wrote.result))], ['error', true])
  })

  it('⛔ a pasta de outro agente: recusada por caminho, e fora da listagem, mesmo dentro da raiz', async () => {
    const free = makeFileTools({ rootFor: () => root, ownFolder: () => ({ dir: mine, read: true, write: true }) })
    const call = (name: string, args: Record<string, unknown>) => free.find((tool) => tool.name === name)!.execute(args)
    const read = await call('read_file', { path: 'agents/leo/segredo.md' })
    assert.deepEqual([read.status, /another agent/.test(String(read.result))], ['error', true])
    assert.equal((await call('write_file', { path: 'agents/leo/x.md', content: 'x' })).status, 'error')
    assert.equal((await call('read_file', { path: join(data, 'global', 'agents', 'outro', 'a') })).status, 'error')
    const listed = await call('list_files', { pattern: '**/*' })
    assert.ok(!String(listed.result).includes('segredo.md'))
    const found = await call('search_files', { pattern: 'dele' })
    assert.equal(found.result, 'No matches.')
  })
})

describe('File.Tools — ⛔ a pasta de uma skill compartilhada com o projeto (só leitura)', () => {
  let data: string
  let beta: string
  let skill: string
  let other: string
  before(() => {
    data = mkdtempSync(join(tmpdir(), 'file-tools-shared-'))
    beta = join(data, 'projects', 'beta')
    skill = join(data, 'projects', 'alfa', 'skills', 'deploy')
    other = join(data, 'projects', 'alfa', 'skills', 'privada')
    for (const dir of [beta, join(skill, 'scripts'), other]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(skill, 'scripts', 'run.sh'), 'echo deploy')
    writeFileSync(join(other, 'x.sh'), 'echo privada')
    writeFileSync(join(data, 'projects', 'alfa', 'nota.md'), 'do alfa')
  })
  after(() => rmSync(data, { recursive: true, force: true }))
  const run = (shared: string[], name: string, args: Record<string, unknown>) =>
    makeFileTools({ rootFor: () => beta, access: () => 'sem regra', sharedFolders: () => shared })
      .find((tool) => tool.name === name)!
      .execute(args)

  it('lê, lista e busca na pasta compartilhada, pelo caminho absoluto, sem regra', async () => {
    const file = join(skill, 'scripts', 'run.sh')
    assert.equal((await run([skill], 'read_file', { path: file })).status, 'success')
    const listed = await run([skill], 'list_files', { pattern: '**/*', path: skill })
    assert.deepEqual(String(listed.result).split('\n'), [join(realpathSync(skill), 'scripts'), join(realpathSync(skill), 'scripts', 'run.sh')])
    assert.match(String((await run([skill], 'search_files', { pattern: 'deploy', path: skill })).result), /run\.sh:1: echo deploy/)
  })

  it('⛔ não grava nela', async () => {
    assert.equal((await run([skill], 'write_file', { path: join(skill, 'scripts', 'novo.sh'), content: 'x' })).status, 'error')
    assert.equal((await run([skill], 'edit_file', { path: join(skill, 'scripts', 'run.sh'), old_string: 'echo', new_string: 'rm' })).status, 'error')
    assert.equal(readFileSync(join(skill, 'scripts', 'run.sh'), 'utf8'), 'echo deploy')
  })

  it('⛔ outra skill do alfa e o resto do projeto de origem seguem negados', async () => {
    for (const path of [join(other, 'x.sh'), join(data, 'projects', 'alfa', 'nota.md'), join(skill, '..', 'privada', 'x.sh')]) {
      assert.equal((await run([skill], 'read_file', { path })).status, 'error', path)
    }
    assert.equal((await run([skill], 'list_files', { pattern: '**/*', path: join(data, 'projects', 'alfa') })).status, 'error')
  })

  it('⛔ sem compartilhar (ou depois de parar), a pasta é negada', async () => {
    const file = join(skill, 'scripts', 'run.sh')
    assert.equal((await run([], 'read_file', { path: file })).status, 'error')
    assert.equal((await run([], 'list_files', { pattern: '**/*', path: skill })).status, 'error')
  })

  it('⛔ um link dentro da pasta compartilhada que sai dela não é seguido', async () => {
    symlinkSync(join(data, 'projects', 'alfa', 'nota.md'), join(skill, 'atalho.md'))
    assert.equal((await run([skill], 'read_file', { path: join(skill, 'atalho.md') })).status, 'error')
  })
})
