import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { cercoPlan } from '@domain/Cerco.Plan'
import { commandDirOf } from '@infra/accounts/Ssh.Kit'
import {
  cleanLegacyScratch,
  ensureGitProxyAuth,
  expandGlobPath,
  findUnder,
  forBubblewrap,
  withWriteGlobsExpanded,
  hostSocketDirs,
  localForwards,
  projectPathIssue,
  ProjectSandbox,
  writeFolders,
} from './Project.Sandbox'

describe('ProjectSandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-sandbox-test-'))
  const env = { CONVERSATIONS_DB: join(root, 'gateway.db') } as NodeJS.ProcessEnv
  after(() => rmSync(root, { recursive: true, force: true }))

  const fakeSrt = (fail?: string) => {
    const calls: Array<{ command: string; config?: Record<string, unknown> }> = []
    const cleanups = { count: 0 }
    return {
      calls,
      cleanups,
      load: async () => ({
        SandboxManager: {
          initialize: async () => undefined,
          cleanupAfterCommand: () => {
            cleanups.count += 1
          },
          getLinuxHttpSocketPath: () => '/tmp/claude-http-x.sock',
          getLinuxSocksSocketPath: () => '/tmp/claude-http-x.sock',
          wrapWithSandbox: async (command: string, _shell?: string, config?: Record<string, unknown>) => {
            calls.push({ command, config })
            return fail ? `echo '${fail}' >&2; exit 1` : command
          },
        },
      }),
    }
  }

  it('⛔ a política: grava só no projeto; o resto dos dados, o app e o HOME ficam fechados; as ferramentas, abertas', () => {
    const policy = new ProjectSandbox(env, fakeSrt().load).policy('xpto') as { filesystem: Record<string, string[]>; enableWeakerNestedSandbox?: boolean }
    const project = join(root, 'projects', 'xpto')
    assert.deepStrictEqual(policy.filesystem.allowWrite, [project])
    // ⛔ Sem agente aqui: as pastas privadas dos agentes do projeto ficam fechadas.
    assert.deepStrictEqual(policy.filesystem.denyRead, [root, process.cwd(), homedir(), ...hostSocketDirs(), join(project, 'agents')])
    // As de recurso só leitura: skills e commands (globais e do projeto); nunca a pasta de agente.
    assert.deepStrictEqual(policy.filesystem.allowRead.slice(0, 6), [
      project,
      join(root, 'tools'),
      join(root, 'global', 'skills'),
      join(root, 'global', 'commands'),
      join(project, 'skills'),
      join(project, 'commands'),
    ])
    // E só o auxiliar de seccomp do srt, que mora em `node_modules` (dentro do app, que fica fechado).
    assert.ok(policy.filesystem.allowRead.slice(6).every((path) => /sandbox-runtime[/\\]vendor[/\\]seccomp$/.test(path)))
    // ⛔ Os arquivos de recurso: lidos, nunca gravados (os do projeto moram dentro da pasta gravável).
    assert.deepStrictEqual(policy.filesystem.denyWrite, [join(project, 'skills'), join(project, 'commands'), join(project, 'agents'), join(root, 'global')])
    assert.strictEqual(policy.enableWeakerNestedSandbox, undefined)
    assert.strictEqual(
      (new ProjectSandbox({ ...env, SANDBOX_NESTED: '1' }, fakeSrt().load).policy('xpto') as { enableWeakerNestedSandbox?: boolean }).enableWeakerNestedSandbox,
      true,
    )
  })

  it('o wrap leva a política do projeto e põe HOME, TMPDIR e caches dentro dele', async () => {
    const srt = fakeSrt()
    const sandbox = new ProjectSandbox(env, srt.load)
    if (!(await sandbox.status()).available) return // plataforma sem sandbox: o teste do status cobre
    const line = await sandbox.wrap('npm install', 'xpto')
    const project = join(root, 'projects', 'xpto')
    assert.ok(line.endsWith('; npm install'))
    assert.ok(line.includes(`export HOME='${join(project, '.home')}'`) && line.includes(`export npm_config_cache='${join(project, '.cache', 'npm')}'`))
    assert.deepStrictEqual((srt.calls.at(-1)?.config as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite, [project])
    // A ponte do proxy (no `/tmp` do host, fechado no Linux) volta: uma vez só, mesmo quando HTTP e SOCKS são o mesmo.
    assert.strictEqual((srt.calls.at(-1)?.config as { filesystem: { allowRead: string[] } }).filesystem.allowRead.filter((path) => path === '/tmp/claude-http-x.sock').length, 1)
  })

  it('⛔ a pasta privada: a do agente pela capacidade (ler, gravar); as dos outros fechadas, mesmo com a regra `**`', () => {
    const sandbox = new ProjectSandbox(env, fakeSrt().load)
    const project = join(root, 'projects', 'xpto')
    const mine = join(project, 'agents', 'maya')
    const others = [join(project, 'agents', 'leo'), join(root, 'global', 'agents', 'atlas')]
    for (const dir of [mine, ...others]) mkdirSync(dir, { recursive: true })
    const layers = {
      project: [
        { category: 'read' as const, pattern: '**', decision: 'allow' as const },
        { category: 'write' as const, pattern: '**', decision: 'allow' as const },
      ],
    }
    const writer = cercoPlan(layers, sandbox.base(project, { agentFolder: { dir: mine, read: true, write: true } }))
    assert.ok(writer.readAllow.includes(mine) && writer.writeAllow.includes(mine))
    for (const dir of others) assert.ok(writer.readDeny.includes(dir) && writer.writeDeny.includes(dir), dir)
    assert.ok(!writer.readDeny.includes(mine) && !writer.writeDeny.includes(mine))
    // Só leitura (Terminal, Ler arquivos): lê a dela, não grava fora do que as regras dão.
    const reader = cercoPlan({}, sandbox.base('/tmp/conversa', { agentFolder: { dir: join(root, 'global', 'agents', 'atlas'), read: true, write: false } }))
    assert.ok(reader.readAllow.includes(join(root, 'global', 'agents', 'atlas')))
    assert.ok(!reader.writeAllow.includes(join(root, 'global', 'agents', 'atlas')))
    assert.ok(!reader.readDeny.includes(join(root, 'global', 'agents', 'atlas')))
  })

  it('⛔ a skill compartilhada com o projeto: o comando lê a pasta dela e não grava; o resto do projeto de origem segue negado', () => {
    const sandbox = new ProjectSandbox(env, fakeSrt().load)
    const beta = join(root, 'projects', 'beta')
    const shared = join(root, 'projects', 'alfa', 'skills', 'deploy')
    const notShared = join(root, 'projects', 'alfa', 'skills', 'privada')
    for (const dir of [beta, shared, notShared]) mkdirSync(dir, { recursive: true })
    const layers = { project: [{ category: 'write' as const, pattern: '**', decision: 'allow' as const }] }
    const withShare = cercoPlan(layers, sandbox.base(beta, { sharedFolders: [shared] }))
    assert.ok(withShare.readAllow.includes(shared))
    assert.ok(withShare.writeDeny.includes(shared))
    assert.ok(!withShare.writeAllow.includes(shared))
    assert.ok(!withShare.readAllow.includes(notShared) && !withShare.readAllow.includes(join(root, 'projects', 'alfa')))
    assert.ok(withShare.readDeny.includes(root) || withShare.readDeny.length > 0)
    // Sem compartilhar: nada de alfa.
    const none = cercoPlan(layers, sandbox.base(beta))
    assert.ok(!none.readAllow.includes(shared))
  })

  it('⛔ na worktree, o cerco nega gravar o .git dela, o commondir e o gitdir (caminhos do servidor, literais)', () => {
    const tree = '/w/p/repositories/abc/_worktrees/EP-1'
    const common = '/w/p/repositories/abc/.git'
    const sandbox = new ProjectSandbox(env, fakeSrt().load)
    const plan = cercoPlan(
      { agent: [{ category: 'write', pattern: '**', decision: 'allow' }] },
      sandbox.base(tree, { gitCommonDir: common, worktreeGitDir: `${common}/worktrees/EP-1` }),
    )
    for (const path of [`${tree}/.git`, `${common}/worktrees/EP-1/commondir`, `${common}/worktrees/EP-1/gitdir`, `${common}/modules`, `${common}/info/attributes`])
      assert.ok(plan.writeDeny.includes(path), path)
  })

  it('⛔ socket Unix liberado só no Linux, e lá os sockets do host ficam fora de alcance (docker, bus do systemd, /tmp)', () => {
    assert.deepStrictEqual(hostSocketDirs('linux'), ['/run', '/var/run', '/tmp'])
    assert.deepStrictEqual(hostSocketDirs('darwin'), [])
    const base = new ProjectSandbox(env, fakeSrt().load).base('/w/p')
    for (const dir of hostSocketDirs()) assert.ok(base.alwaysDeny.includes(dir), dir)
  })

  it('⚖️ o git manda o token do proxy já no CONNECT (sem isto caía com "Proxy CONNECT aborted"), sem apagar o que havia', () => {
    const home = join(root, 'casa-git')
    mkdirSync(home, { recursive: true })
    ensureGitProxyAuth(home)
    const gitconfig = join(home, '.gitconfig')
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), '[http]\n\tproxyAuthMethod = basic\n')
    writeFileSync(gitconfig, '[user]\n\tname = Maya')
    ensureGitProxyAuth(home)
    ensureGitProxyAuth(home)
    assert.strictEqual(readFileSync(gitconfig, 'utf8'), '[user]\n\tname = Maya\n[http]\n\tproxyAuthMethod = basic\n')
  })

  it('⛔ M4: a limpeza dos restos antigos (.home/.accounts, .cache/logs, .cache/proxychains-*.conf) roda uma vez, só nesses caminhos, sem seguir link', () => {
    const base = join(root, 'projeto-velho')
    const outside = join(root, 'fora-do-projeto')
    mkdirSync(join(base, '.home', '.accounts', 'conta'), { recursive: true })
    mkdirSync(join(base, '.cache', 'logs'), { recursive: true })
    mkdirSync(join(base, '.cache', 'npm'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(base, '.home', '.accounts', 'conta', 'id_ed25519'), 'chave')
    writeFileSync(join(base, '.home', '.gitconfig'), '[user]\n')
    writeFileSync(join(base, '.cache', 'logs', 'a.log'), 'x')
    writeFileSync(join(base, '.cache', 'proxychains-abc.conf'), 'token')
    writeFileSync(join(base, '.cache', 'proxychains.txt'), 'fica')
    writeFileSync(join(base, '.cache', 'npm', 'pacote'), 'fica')
    writeFileSync(join(outside, 'dado'), 'do alvo do link')
    symlinkSync(outside, join(base, '.cache', 'logs', 'link'))

    cleanLegacyScratch(base)
    assert.strictEqual(existsSync(join(base, '.home', '.accounts')), false)
    assert.strictEqual(existsSync(join(base, '.cache', 'logs', 'a.log')), false)
    assert.strictEqual(existsSync(join(base, '.cache', 'logs', 'link')), false, 'o link sai')
    assert.strictEqual(existsSync(join(outside, 'dado')), true, 'o alvo do link fica')
    assert.strictEqual(existsSync(join(base, '.cache', 'proxychains-abc.conf')), false)
    for (const kept of [join('.home', '.gitconfig'), join('.cache', 'proxychains.txt'), join('.cache', 'npm', 'pacote')]) assert.ok(existsSync(join(base, kept)), kept)

    // Com a marca, não apaga de novo (um `.accounts` novo é de agora, não resto).
    mkdirSync(join(base, '.home', '.accounts'), { recursive: true })
    cleanLegacyScratch(base)
    assert.ok(existsSync(join(base, '.home', '.accounts')))
  })

  it('⛔ M4: `.home` ou `.cache` que é link não é seguido (nada fora do projeto é apagado)', () => {
    const base = join(root, 'projeto-link')
    const outside = join(root, 'fora-link')
    mkdirSync(join(outside, '.accounts'), { recursive: true })
    writeFileSync(join(outside, '.accounts', 'chave'), 'alheia')
    mkdirSync(join(base, '.cache'), { recursive: true })
    symlinkSync(outside, join(base, '.home'))
    cleanLegacyScratch(base)
    assert.ok(existsSync(join(outside, '.accounts', 'chave')))
  })

  it('⚖️ a limpeza dos pontos de montagem do bwrap: uma por comando embrulhado, o teste do status incluído', async () => {
    const srt = fakeSrt()
    const sandbox = new ProjectSandbox(env, srt.load)
    if (!(await sandbox.status()).available) return
    assert.strictEqual(srt.cleanups.count, 1)
    await sandbox.wrap('ls', 'xpto')
    sandbox.done()
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(srt.cleanups.count, 2)
  })

  it('⛔ a pasta privada do comando (chave SSH, proxychains) fica na pasta de dados, fechada aos outros: só o dono recebe leitura dela', async () => {
    const srt = fakeSrt()
    const sandbox = new ProjectSandbox(env, srt.load)
    if (!(await sandbox.status()).available) return
    const run = sandbox.runDir()
    assert.ok(run.startsWith(root), 'dentro da pasta de dados (que o cerco nega a todo comando)')
    const mine = commandDirOf(run, 'tok-meu')
    const other = commandDirOf(run, 'tok-outro')
    mkdirSync(mine, { recursive: true })
    mkdirSync(other, { recursive: true })
    const project = join(root, 'projeto')
    mkdirSync(project, { recursive: true })
    await sandbox.wrapWith('ls', project, (base) => cercoPlan({ agent: [], project: [] }, { ...base, system: [] }), 'tok-meu')
    const allow = (srt.calls.at(-1)!.config!.filesystem as { allowRead: string[] }).allowRead
    assert.ok(allow.includes(mine), 'o dono lê a sua')
    assert.ok(!allow.includes(other) && !allow.includes(run), 'o resto fica fechado')
  })

  it('⛔ cerco que não sobe: status indisponível com o erro real, e o wrap recusa', async () => {
    const sandbox = new ProjectSandbox(env, fakeSrt('bwrap: No permissions to create new namespace').load)
    const status = await sandbox.status()
    if (process.platform !== 'darwin' && process.platform !== 'linux') return assert.strictEqual(status.available, false)
    assert.deepStrictEqual([status.available, status.reason], [false, 'bwrap: No permissions to create new namespace'])
    await assert.rejects(() => sandbox.wrap('ls', 'xpto'), /cerco indisponível neste servidor: bwrap/)
  })
})

describe('projectPathIssue — o filtro de caminho das ferramentas de arquivo', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-path-test-'))
  const project = join(root, 'xpto')
  mkdirSync(join(project, 'src'), { recursive: true })
  symlinkSync('/etc', join(project, 'atalho'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('dentro passa: relativo, absoluto, arquivo que ainda não existe, Glob sem path', () => {
    assert.strictEqual(projectPathIssue(project, project, 'Read', { file_path: 'src/a.ts' }), undefined)
    assert.strictEqual(projectPathIssue(project, project, 'Write', { file_path: join(project, 'novo', 'b.md') }), undefined)
    assert.strictEqual(projectPathIssue(project, project, 'Glob', { pattern: '**/*.ts' }), undefined)
    assert.strictEqual(projectPathIssue(project, project, 'WebFetch', { url: 'https://x' }), undefined)
  })

  it('⛔ fora é recusado: absoluto, `..`, symlink que aponta para fora, glob absoluto, Grep em outra pasta', () => {
    for (const [tool, input] of [
      ['Read', { file_path: '/etc/hosts' }],
      ['Edit', { file_path: '../outro/x' }],
      ['Read', { file_path: 'atalho/hosts' }],
      ['Glob', { pattern: '/etc/**/*.conf' }],
      ['Grep', { path: root }],
      ['NotebookEdit', { notebook_path: '/tmp/x.ipynb' }],
    ] as Array<[string, Record<string, unknown>]>)
      assert.match(projectPathIssue(project, project, tool, input) ?? '', /fora da pasta do projeto/, `${tool} ${JSON.stringify(input)}`)
  })
})

describe('forBubblewrap — o cerco no Linux', () => {
  // A pasta de dados com o projeto dentro, as ferramentas e outro projeto (o caso do pod).
  const tree: Record<string, string[]> = { '/data': ['gateway.db', 'secrets.key', 'tools', 'projects'], '/data/projects': ['xpto', 'outro'] }
  const list = (dir: string) => tree[dir] ?? []
  const root = '/data/projects/xpto'
  const plan = (readAllow: string[]) => ({ readDeny: ['/data', '/home/gw', root, `${root}/**/.env`], readAllow, writeAllow: [`${root}/apps/**`], writeDeny: [] })

  it('⛔ a pasta que contém a raiz vira o fechamento de cada vizinho no caminho; as ferramentas reabertas ficam de fora', () => {
    const linux = forBubblewrap(plan([`${root}/.home`, '/data/tools', `${root}/**`]), root, list)
    assert.deepStrictEqual(linux.readDeny, ['/data/gateway.db', '/data/secrets.key', '/data/projects/outro', '/home/gw', `${root}/**/.env`])
  })

  it('a raiz liberada inteira para leitura não é fechada e reaberta (a escrita dentro dela morreria)', () => {
    const linux = forBubblewrap(plan([`${root}/.home`, '/data/tools', `${root}/**`]), root, list)
    assert.ok(!linux.readDeny.includes(root) && !linux.readAllow.includes(`${root}/**`))
    assert.ok(linux.readDeny.includes(`${root}/**/.env`))
  })

  it('leitura parcial: a raiz segue fechada, só o liberado reabre', () => {
    const linux = forBubblewrap(plan(['/data/tools', `${root}/src/**`]), root, list)
    assert.ok(linux.readDeny.includes(root) && linux.readAllow.includes(`${root}/src/**`))
  })
})

describe('writeFolders — as pastas de escrita criadas antes do comando', () => {
  it('só pasta explícita, sem curinga, dentro da raiz', () => {
    const plan = {
      readDeny: [],
      readAllow: [],
      writeDeny: [],
      writeAllow: ['/w/p/.home', '/w/p/notas/**', '/w/p/apps/legado/**', '/w/p/**/*.txt', '/w/p/**', '/w/outro/**', '/w/p/../fora/**', '/w/p/src/*/gen/**'],
    }
    assert.deepStrictEqual(writeFolders(plan, '/w/p'), ['/w/p/notas', '/w/p/apps/legado'])
  })

  it('⛔ serviços locais no Linux: um socat por porta liberada, pelo portão, com o token do comando', () => {
    const line = localForwards([27017, 27017, 6379, 0, 70000], 'tok123', 3128)
    assert.strictEqual(line.match(/socat /g)?.length, 2)
    assert.match(line, /socat TCP-LISTEN:27017,bind=127\.0\.0\.1,reuseaddr,fork PROXY:127\.0\.0\.1:localhost:27017,proxyport=3128,proxyauth=tok123:x/)
    assert.match(line, /trap 'kill \$\(jobs -p\) 2>\/dev\/null' EXIT/)
    assert.strictEqual(localForwards([], 't', 3128), '')
  })
})

describe('findUnder — os modelos de segredo reabertos para leitura', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-find-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('⚖️ pula outro checkout dentro da raiz (as worktrees): o teto da busca não se gasta nelas', () => {
    mkdirSync(join(root, '.agents', 'skills', 'x'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'x', '.env.example'), 'A=')
    mkdirSync(join(root, '_worktrees', 'EP-1', 'apps'), { recursive: true })
    writeFileSync(join(root, '_worktrees', 'EP-1', '.git'), 'gitdir: ../../.git/worktrees/EP-1')
    writeFileSync(join(root, '_worktrees', 'EP-1', 'apps', '.env.example'), 'A=')
    assert.deepStrictEqual(findUnder(root, '**/.env.*'), ['.agents/skills/x/.env.example'])
  })
})

describe('expandGlobPath — a escrita com curinga no Linux (o runtime a ignora)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-glob-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('⚖️ vira os caminhos que existem: os arquivos do padrão e a pasta do `/**`; sem node_modules; sem curinga, nada', () => {
    const repo = join(root, 'repo')
    for (const dir of ['apps/a/src', 'apps/b', 'node_modules/x', '_worktrees/EP-1/evidence', '_worktrees/EP-2/evidence', '_worktrees/EP-3'])
      mkdirSync(join(repo, dir), { recursive: true })
    for (const file of ['apps/a/src/x.test.ts', 'apps/a/src/x.ts', 'apps/b/y.test.ts', 'node_modules/x/z.test.ts']) writeFileSync(join(repo, file), '')
    assert.deepStrictEqual(expandGlobPath(join(repo, '**/*.test.ts')).sort(), [join(repo, 'apps/a/src/x.test.ts'), join(repo, 'apps/b/y.test.ts')])
    assert.deepStrictEqual(expandGlobPath(join(repo, '_worktrees/*/evidence/**')).sort(), [join(repo, '_worktrees/EP-1/evidence/**'), join(repo, '_worktrees/EP-2/evidence/**')])
    assert.deepStrictEqual(expandGlobPath(join(repo, 'apps/**')), [])
    // O plano: o padrão fica, e os caminhos entram na escrita e na negação.
    const plan = withWriteGlobsExpanded({ readAllow: [], readDeny: [], writeAllow: [join(repo, '**/*.test.ts')], writeDeny: [join(repo, 'apps/*/src/x.test.ts')] })
    assert.ok(plan.writeAllow.includes(join(repo, '**/*.test.ts')) && plan.writeAllow.includes(join(repo, 'apps/b/y.test.ts')))
    assert.ok(plan.writeDeny.includes(join(repo, 'apps/a/src/x.test.ts')))
  })
})
