import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { cloneRepository, cloneSource, initRepository, removeRepository, repositoriesInSetup, repositoryNameFrom, RepositorySetupError } from './Repository.Setup'
import { listRepositories } from './Work.Folder'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })

const failsWith = (code: string, message?: RegExp) => (error: unknown) => error instanceof RepositorySetupError && error.code === code && (!message || message.test(error.message))

describe('Repository.Setup (criar, clonar e remover repositório do projeto)', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gw-rs-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'gw-rs-fora-')))
  const upstream = join(outside, 'upstream')
  const PUBLIC = async () => ['93.184.216.34']
  /** O git de mentira: confere o que o gateway pediu e clona de uma pasta local no lugar da rede. */
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const fakeGit = async (args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env })
    const branch = args.includes('--branch') ? ['--branch', args[args.indexOf('--branch') + 1]] : []
    execFileSync('git', ['clone', '-q', ...branch, upstream, args[args.length - 1]], { stdio: 'ignore' })
  }

  before(() => {
    mkdirSync(upstream, { recursive: true })
    git(upstream, 'init', '-q', '-b', 'main')
    writeFileSync(join(upstream, 'a.txt'), 'a')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '-q', '-m', 'a')
    git(upstream, 'branch', 'automation')
  })
  after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('⛔ a URL: só https, sem credencial, sem ? nem #, com caminho; o nome sai do fim dela', () => {
    for (const raw of ['git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', 'http://github.com/a/b', 'file:///etc', 'ext::sh -c id', 'https://github.com', ''])
      assert.throws(() => cloneSource(raw), failsWith('invalid', /^url:/), raw)
    assert.throws(() => cloneSource('https://fulano:token123@github.com/a/b.git'), failsWith('invalid', /sem usuário ou token/))
    assert.throws(() => cloneSource('https://github.com/a/b.git?x=1'), failsWith('invalid'))
    assert.strictEqual(repositoryNameFrom(cloneSource('https://github.com/empresa/app.git')), 'app')
    assert.strictEqual(repositoryNameFrom(cloneSource('https://dev.azure.com/org/projeto/_git/servico/')), 'servico')
  })

  it('clona para repositories/<nome>, com as travas do git e a credencial só no ambiente', async () => {
    calls.length = 0
    const env = { GATEWAY_GH_0: 'tok-secreto-1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '!f() { :; }; f' }
    const name = await cloneRepository(project, { source: ' https://github.com/empresa/app.git ', env }, { git: fakeGit, resolve: PUBLIC })
    assert.strictEqual(name, 'app')
    assert.ok(existsSync(join(project, 'repositories', 'app', 'a.txt')))
    const { args, env: used } = calls[0]
    const flat = args.join(' ')
    for (const guard of ['protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false', 'core.hooksPath=/dev/null', '--no-recurse-submodules'])
      assert.ok(flat.includes(guard), guard)
    assert.ok(flat.includes('http.curloptResolve=github.com:443:93.184.216.34'), 'o endereço conferido é o que o git usa')
    assert.deepStrictEqual(args.slice(-3), ['--', 'https://github.com/empresa/app.git', join(project, 'repositories', 'app')])
    assert.ok(!flat.includes('tok-secreto-1'), 'o token nunca vai no argv')
    assert.strictEqual(used.GATEWAY_GH_0, 'tok-secreto-1')
    assert.deepStrictEqual([used.GIT_TERMINAL_PROMPT, used.GIT_CONFIG_GLOBAL, used.HOME], ['0', '/dev/null', '/nonexistent'])
    assert.deepStrictEqual(repositoriesInSetup(project), [])
    assert.strictEqual(listRepositories(project).find((item) => item.name === 'app')?.branch, 'main')
  })

  it('o nome e a branch escolhidos; repetir o nome é 409 (exists)', async () => {
    assert.strictEqual(
      await cloneRepository(project, { source: 'https://github.com/empresa/app.git', name: 'outro', branch: 'automation' }, { git: fakeGit, resolve: PUBLIC }),
      'outro',
    )
    assert.strictEqual(listRepositories(project).find((item) => item.name === 'outro')?.branch, 'automation')
    await assert.rejects(cloneRepository(project, { source: 'https://github.com/empresa/app.git', name: 'outro' }, { git: fakeGit, resolve: PUBLIC }), failsWith('exists'))
  })

  it('⛔ nome reservado, com ponto na frente ou com barra; branch com espaço', async () => {
    for (const name of ['_worktrees', '.git', '..', 'a/b', '-x', 'a b'])
      await assert.rejects(cloneRepository(project, { source: 'https://github.com/e/app.git', name }, { git: fakeGit, resolve: PUBLIC }), failsWith('invalid', /^name:/), name)
    await assert.rejects(cloneRepository(project, { source: 'https://github.com/e/x.git', branch: 'a b' }, { git: fakeGit, resolve: PUBLIC }), failsWith('invalid', /^branch:/))
    await assert.rejects(initRepository(project, { name: 'x', branch: '--upload-pack=x' }), failsWith('invalid', /^branch:/))
  })

  it('⛔ o destino: loopback e metadados nunca; rede privada só com a Conta desse servidor', async () => {
    const never = async () => {
      throw new Error('o git não pode rodar')
    }
    const to = (address: string) => async () => [address]
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', '0.0.0.0'])
      await assert.rejects(
        cloneRepository(project, { source: 'https://git.interno.test/a/n1.git' }, { git: never, resolve: to(address) }),
        failsWith('invalid', /sempre negado/),
        address,
      )
    await assert.rejects(cloneRepository(project, { source: 'https://127.0.0.1/a/n2.git' }, { git: never, resolve: PUBLIC }), failsWith('invalid', /sempre negado/))
    await assert.rejects(cloneRepository(project, { source: 'https://git.interno.test/a/n3.git' }, { git: never, resolve: to('10.0.0.5') }), failsWith('invalid', /rede privada/))
    // Um endereço público e um privado para o mesmo nome: vale o pior.
    await assert.rejects(
      cloneRepository(project, { source: 'https://git.interno.test/a/n4.git' }, { git: never, resolve: async () => ['93.184.216.34', '10.0.0.5'] }),
      failsWith('invalid', /rede privada/),
    )
    await assert.rejects(
      cloneRepository(project, { source: 'https://git.interno.test/a/n5.git', privateHost: 'outro.interno.test' }, { git: never, resolve: to('10.0.0.5') }),
      failsWith('invalid', /rede privada/),
    )
    await assert.rejects(
      cloneRepository(project, { source: 'https://nao.existe.test/a/n6.git' }, { git: never, resolve: async () => [] }),
      failsWith('invalid', /não foi encontrado/),
    )
    assert.strictEqual(
      await cloneRepository(project, { source: 'https://git.interno.test/a/privado.git', privateHost: 'git.interno.test' }, { git: fakeGit, resolve: to('10.0.0.5') }),
      'privado',
    )
    for (const name of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) assert.ok(!existsSync(join(project, 'repositories', name)), name)
  })

  it('⛔ o clone que falha não deixa pasta, e a mensagem sai sem o token', async () => {
    const failing = async (args: string[]) => {
      mkdirSync(args[args.length - 1], { recursive: true })
      throw Object.assign(new Error('Command failed'), {
        stderr: "Cloning into 'x'...\nremote: token tok-secreto-9 recusado\nfatal: Authentication failed for 'https://github.com/e/falha.git/'\n",
      })
    }
    await assert.rejects(
      cloneRepository(project, { source: 'https://github.com/e/falha.git', env: { GATEWAY_GH_0: 'tok-secreto-9' } }, { git: failing, resolve: PUBLIC }),
      (error: unknown) => failsWith('failed', /escolha uma Conta/)(error) && !(error as Error).message.includes('tok-secreto-9') && (error as Error).message.includes('***'),
    )
    assert.ok(!existsSync(join(project, 'repositories', 'falha')))
    assert.deepStrictEqual(repositoriesInSetup(project), [])
    const slow = async () => {
      throw Object.assign(new Error('timeout'), { killed: true })
    }
    await assert.rejects(
      cloneRepository(project, { source: 'https://github.com/e/lento.git' }, { git: slow, resolve: PUBLIC, timeoutMs: 120_000 }),
      failsWith('failed', /passou de 2 min/),
    )
  })

  it('enquanto o clone corre, o nome aparece em preparo e não pode ser clonado nem removido', async () => {
    let release: () => void = () => undefined
    const waiting = new Promise<void>((done) => (release = done))
    const held = async (args: string[], env: NodeJS.ProcessEnv) => {
      await waiting
      await fakeGit(args, env)
    }
    const running = cloneRepository(project, { source: 'https://github.com/e/demorado.git' }, { git: held, resolve: PUBLIC })
    await new Promise((done) => setImmediate(done))
    assert.deepStrictEqual(repositoriesInSetup(project), ['demorado'])
    await assert.rejects(cloneRepository(project, { source: 'https://github.com/e/demorado.git' }, { git: fakeGit, resolve: PUBLIC }), failsWith('busy'))
    await assert.rejects(removeRepository(project, 'demorado'), failsWith('busy'))
    release()
    assert.strictEqual(await running, 'demorado')
    assert.deepStrictEqual(repositoriesInSetup(project), [])
  })

  it('git local: nasce sem remoto, na branch pedida, com um commit — e já aceita worktree', async () => {
    assert.strictEqual(await initRepository(project, { name: 'local', branch: 'automation', author: 'gateway do <Henrique>' }), 'local')
    const dir = join(project, 'repositories', 'local')
    const entry = listRepositories(project).find((item) => item.name === 'local')
    assert.deepStrictEqual(entry, { name: 'local', branch: 'automation', worktrees: [] })
    assert.strictEqual(
      execFileSync('git', ['-C', dir, 'log', '-1', '--format=%an <%ae> %s'], { encoding: 'utf8' }).trim(),
      'gateway do Henrique <gateway@localhost> Início do repositório',
    )
    git(dir, 'worktree', 'add', '-q', '-b', 'h/EP-1', join(project, 'repositories', '_worktrees', 'EP-1'))
    assert.deepStrictEqual(listRepositories(project).find((item) => item.name === 'local')?.worktrees, [{ name: 'EP-1', branch: 'h/EP-1', path: 'repositories/_worktrees/EP-1' }])
    assert.strictEqual(await initRepository(project, { name: 'padrao' }), 'padrao')
    assert.strictEqual(listRepositories(project).find((item) => item.name === 'padrao')?.branch, 'main')
    await assert.rejects(initRepository(project, { name: 'local' }), failsWith('exists'))
  })

  it('remover leva a pasta e as worktrees dele em repositories/; a de fora fica e é avisada', async () => {
    const dir = join(project, 'repositories', 'local')
    git(dir, 'worktree', 'add', '-q', '-b', 'h/dentro', join(dir, '.worktrees', 'dentro'))
    mkdirSync(join(project, 'docs'), { recursive: true })
    git(dir, 'worktree', 'add', '-q', '-b', 'h/solta', join(project, 'docs', 'solta'))
    git(dir, 'worktree', 'add', '-q', '-b', 'h/fora', join(outside, 'wt-fora'))
    assert.deepStrictEqual(await removeRepository(project, 'local'), { kept: ['docs/solta'] })
    assert.ok(!existsSync(dir))
    assert.ok(!existsSync(join(project, 'repositories', '_worktrees', 'EP-1')), 'a worktree em repositories/ sai junto')
    assert.ok(existsSync(join(project, 'docs', 'solta')), 'a de fora de repositories/ fica')
    assert.ok(existsSync(join(outside, 'wt-fora')), 'a de fora do projeto nunca é tocada')
    assert.ok(existsSync(join(project, 'repositories', 'padrao', '.git')), 'os outros repositórios ficam')
    assert.ok(!listRepositories(project).some((item) => item.name === 'local'))
  })

  it('⛔ remover: nome com barra, pasta que não é repositório, link e o que não existe', async () => {
    mkdirSync(join(project, 'repositories', 'nao-git'))
    symlinkSync(join(project, 'repositories', 'padrao'), join(project, 'repositories', 'atalho'))
    for (const name of ['../x', '..', 'a/b']) await assert.rejects(removeRepository(project, name), failsWith('invalid'), name)
    for (const name of ['nao-git', 'atalho', 'zzz', '_worktrees']) await assert.rejects(removeRepository(project, name), failsWith('not_found'), name)
    assert.ok(existsSync(join(project, 'repositories', 'nao-git')))
    assert.ok(existsSync(join(project, 'repositories', 'padrao', '.git')))
  })

  it('⛔ a worktree que guarda a worktree de outro repositório fica no disco', async () => {
    await initRepository(project, { name: 'dono' })
    await initRepository(project, { name: 'vizinho' })
    const shared = join(project, 'repositories', '_worktrees')
    git(join(project, 'repositories', 'dono'), 'worktree', 'add', '-q', '-b', 'h/tudo', shared)
    git(join(project, 'repositories', 'vizinho'), 'worktree', 'add', '-q', '-b', 'h/V-1', join(shared, 'V-1'))
    assert.deepStrictEqual(await removeRepository(project, 'dono'), { kept: ['repositories/_worktrees'] })
    assert.ok(!existsSync(join(project, 'repositories', 'dono')))
    assert.ok(existsSync(join(shared, 'V-1', '.git')), 'a worktree do vizinho continua lá')
    assert.deepStrictEqual(await removeRepository(project, 'vizinho'), { kept: [] })
    assert.ok(!existsSync(join(shared, 'V-1')))
  })
})
