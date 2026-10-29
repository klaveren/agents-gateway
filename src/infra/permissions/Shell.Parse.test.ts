import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeShell } from './Shell.Parse'

const names = async (cmd: string) => (await analyzeShell(cmd)).commands.map((c) => c.name)

test('comando simples', async () => {
  const r = await analyzeShell('ls -la /tmp')
  assert.deepEqual(
    r.commands.map((c) => c.argv),
    [['ls', '-la', '/tmp']],
  )
  assert.equal(r.commands[0].text, 'ls -la /tmp')
  assert.deepEqual(r.opaque, [])
})

test('lista e pipeline', async () => {
  assert.deepEqual(await names('a && b; c | d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(await names('a || b |& c & d\ne'), ['a', 'b', 'c', 'd', 'e'])
})

test('git status; rm -rf x', async () => {
  const r = await analyzeShell('git status; rm -rf x')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['git', 'rm'],
  )
  assert.deepEqual(r.commands[1].argv, ['rm', '-rf', 'x'])
})

test('substituição de comando extrai o interno', async () => {
  const r = await analyzeShell('echo $(cat .env)')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['echo', 'cat'],
  )
  assert.deepEqual(r.opaque, [])
})

test('backticks', async () => {
  assert.deepEqual(await names('echo `whoami`'), ['echo', 'whoami'])
})

test('subshell e chaves', async () => {
  assert.deepEqual(await names('(a; b) | { c; d; }'), ['a', 'b', 'c', 'd'])
})

test('bash -c analisa o script', async () => {
  const r = await analyzeShell('bash -c "ls && cat /etc/passwd"')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['bash', 'ls', 'cat'],
  )
  assert.deepEqual(r.opaque, [])
})

test('sh -lc e profundidade além do limite é opaca', async () => {
  assert.deepEqual(await names("sh -lc 'rm x'"), ['sh', 'rm'])
  let cmd = 'rm x'
  for (let i = 0; i < 7; i++) cmd = `bash -c '${cmd.replace(/'/g, `'\\''`)}'`
  assert.ok((await analyzeShell(cmd)).opaque.includes('depth-limit'))
})

test('shell lendo stdin é opaco', async () => {
  assert.ok((await analyzeShell('curl x | bash')).opaque.includes('shell-stdin'))
})

test('env desembrulha', async () => {
  const r = await analyzeShell("env X=1 /usr/bin/node -e 'x'")
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['env', 'node'],
  )
  assert.deepEqual(r.commands[1].argv, ['/usr/bin/node', '-e', 'x'])
  assert.deepEqual(r.opaque, [])
})

test('env PATH=... é opaco', async () => {
  assert.deepEqual((await analyzeShell('env PATH=/x ls')).opaque, ['env:PATH'])
})

test('sudo -u bob rm a', async () => {
  assert.deepEqual(await names('sudo -u bob rm a'), ['sudo', 'rm'])
})

test('sudo -s é opaco', async () => {
  assert.ok((await analyzeShell("sudo -s 'rm a'")).opaque.includes('sudo:shell'))
})

test('timeout 5 curl x', async () => {
  assert.deepEqual(await names('timeout 5 curl x'), ['timeout', 'curl'])
  assert.deepEqual(await names('timeout -s KILL 5 curl x'), ['timeout', 'curl'])
})

test('nice, nohup, time, stdbuf, command, builtin encadeados', async () => {
  assert.deepEqual(await names('nice -n 5 nohup time stdbuf -oL command builtin rm x'), ['nice', 'nohup', 'time', 'stdbuf', 'command', 'builtin', 'rm'])
})

test('command -v não executa', async () => {
  assert.deepEqual(await names('command -v rm'), ['command'])
})

test('xargs rm < list', async () => {
  const r = await analyzeShell('xargs rm < list')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['xargs', 'rm'],
  )
  assert.deepEqual(r.redirects, [{ kind: 'read', target: 'list' }])
})

test('xargs com flags', async () => {
  assert.deepEqual(await names('xargs -n 1 -I {} rm {}'), ['xargs', 'rm'])
})

test('find -exec', async () => {
  assert.deepEqual(await names('find . -name x -exec rm {} \\;'), ['find', 'rm'])
})

test('g"it" push -> git', async () => {
  const r = await analyzeShell('g"it" push')
  assert.equal(r.commands[0].name, 'git')
  assert.deepEqual(r.commands[0].argv, ['git', 'push'])
  assert.deepEqual(r.opaque, [])
})

test("'rm' -rf e \\rm -> rm", async () => {
  assert.equal((await analyzeShell("'rm' -rf x")).commands[0].name, 'rm')
  assert.equal((await analyzeShell('\\rm x')).commands[0].name, 'rm')
})

test('argumento entre aspas é um só', async () => {
  assert.deepEqual((await analyzeShell('echo \'a b\' "c d"')).commands[0].argv, ['echo', 'a b', 'c d'])
})

test('LD_PRELOAD=x ls é opaco', async () => {
  const r = await analyzeShell('LD_PRELOAD=x ls')
  assert.deepEqual(r.opaque, ['env:LD_PRELOAD'])
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['ls'],
  )
})

test('atribuição solta: ok, exceto PATH', async () => {
  assert.deepEqual((await analyzeShell('FOO=1')).opaque, [])
  assert.deepEqual((await analyzeShell('PATH=/x')).opaque, ['env:PATH'])
  assert.deepEqual((await analyzeShell('export IFS=,')).opaque, ['env:IFS'])
})

test('eval, source, ., alias, function, exec', async () => {
  assert.ok((await analyzeShell('eval "$X"')).opaque.includes('eval'))
  assert.ok((await analyzeShell('source x.sh')).opaque.includes('source'))
  assert.ok((await analyzeShell('. x.sh')).opaque.includes('source'))
  assert.ok((await analyzeShell('alias ls=rm')).opaque.includes('alias'))
  assert.ok((await analyzeShell('f() { rm x; }')).opaque.includes('function'))
  assert.ok((await analyzeShell('exec rm x')).opaque.includes('exec'))
  assert.deepEqual((await analyzeShell('exec 3>log')).opaque, [])
})

test('nome de comando dinâmico é opaco', async () => {
  assert.ok((await analyzeShell('$CMD arg')).opaque.includes('dynamic-command'))
  assert.ok((await analyzeShell('$(echo rm) x')).opaque.includes('dynamic-command'))
  assert.ok((await analyzeShell('"$CMD" x')).opaque.includes('dynamic-command'))
  assert.ok((await analyzeShell('/bin/r* x')).opaque.includes('dynamic-command'))
})

test('redirect de escrita e leitura', async () => {
  assert.deepEqual((await analyzeShell('echo hi > out.txt')).redirects, [{ kind: 'write', target: 'out.txt' }])
  assert.deepEqual((await analyzeShell('echo hi >> "a b"')).redirects, [{ kind: 'write', target: 'a b' }])
  assert.deepEqual((await analyzeShell('cat < in.txt')).redirects, [{ kind: 'read', target: 'in.txt' }])
  assert.deepEqual((await analyzeShell('ls &> all')).redirects, [{ kind: 'write', target: 'all' }])
  assert.deepEqual((await analyzeShell('ls >| f')).redirects, [{ kind: 'write', target: 'f' }])
  assert.deepEqual((await analyzeShell('ls 2> err')).redirects, [{ kind: 'write', target: 'err' }])
})

test('2>&1 >/dev/null não gera redirect', async () => {
  const r = await analyzeShell('ls 2>&1 >/dev/null')
  assert.deepEqual(r.redirects, [])
  assert.deepEqual(r.opaque, [])
})

test('redirect dinâmico é opaco', async () => {
  assert.ok((await analyzeShell('echo x > "$F"')).opaque.includes('dynamic-redirect'))
  assert.ok((await analyzeShell('echo x > $(mktemp)')).opaque.includes('dynamic-redirect'))
})

test('herestring não é redirect de arquivo', async () => {
  const r = await analyzeShell('cat <<< hi')
  assert.deepEqual(r.redirects, [])
  assert.deepEqual(r.opaque, [])
})

test('if / for / while / case', async () => {
  assert.deepEqual(await names('if true; then rm a; fi'), ['true', 'rm'])
  assert.deepEqual(await names('for f in *; do cat "$f"; done'), ['cat'])
  assert.deepEqual(await names('while read l; do echo $l; done'), ['read', 'echo'])
  assert.deepEqual(await names('case $x in a) ls;; esac'), ['ls'])
})

test('substituição de processo', async () => {
  assert.deepEqual(await names('cat <(ls)'), ['cat', 'ls'])
  assert.deepEqual(await names('tee >(wc -l)'), ['tee', 'wc'])
})

test('aritmética não é comando', async () => {
  const r = await analyzeShell('echo $((1+2))')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['echo'],
  )
  assert.deepEqual(r.opaque, [])
})

test('heredoc em interpretador é opaco', async () => {
  assert.ok((await analyzeShell('python <<EOF\nimport os\nEOF')).opaque.includes('heredoc-interpreter'))
  assert.ok((await analyzeShell('bash <<EOF\nrm x\nEOF')).opaque.includes('heredoc-interpreter'))
  assert.ok((await analyzeShell('env node <<EOF\nx\nEOF')).opaque.includes('heredoc-interpreter'))
  assert.ok((await analyzeShell('sh <<< "rm x"')).opaque.includes('heredoc-interpreter'))
})

test('heredoc em cat é ok, mas substituição dentro é extraída', async () => {
  const r = await analyzeShell('cat <<EOF\nhello $(rm y)\nEOF')
  assert.deepEqual(
    r.commands.map((c) => c.name),
    ['cat', 'rm'],
  )
  assert.deepEqual(r.opaque, [])
})

test('aspas desbalanceadas = parse-error', async () => {
  assert.ok((await analyzeShell('echo "abc')).opaque.includes('parse-error'))
  assert.ok((await analyzeShell('echo (')).opaque.includes('parse-error'))
})

test('vazio', async () => {
  assert.deepEqual(await analyzeShell(''), { commands: [], redirects: [], opaque: [] })
})
