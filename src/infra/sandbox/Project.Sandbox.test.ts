import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
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
  noProxyFor,
  projectPathIssue,
  ProjectSandbox,
  sweepMountPoints,
  systemReadAllowlist,
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
    assert.deepStrictEqual(hostSocketDirs('linux'), ['/run', '/var/run', '/tmp', '/var/tmp'])
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

  it('⚖️ o prelúdio: no Linux o loopback do cerco vai direto (NO_PROXY); no Mac segue pelo portão (vazio)', async () => {
    const project = join(root, 'projeto-np')
    mkdirSync(project, { recursive: true })
    const preludeOf = async (platform: NodeJS.Platform) => {
      const srt = fakeSrt()
      const sandbox = new ProjectSandbox(env, srt.load, platform)
      await sandbox.wrapWith('ls', project, (base) => cercoPlan({}, { ...base, system: [] }), 'tok-np')
      return srt.calls.at(-1)!.command
    }
    const linux = await preludeOf('linux')
    assert.match(linux, /export NO_PROXY='localhost,127\.0\.0\.1,::1'/)
    assert.match(linux, /export no_proxy='localhost,127\.0\.0\.1,::1'/)
    const mac = await preludeOf('darwin')
    assert.match(mac, /export NO_PROXY=''/)
    assert.match(mac, /export no_proxy=''/)
    assert.deepStrictEqual([noProxyFor('linux'), noProxyFor('darwin')], ['localhost,127.0.0.1,::1', ''])
  })

  it('⛔ a varredura roda antes de um comando cercado sozinho, e NÃO com outro rodando; e de novo quando o último termina', async () => {
    const srt = fakeSrt()
    const sandbox = new ProjectSandbox(env, srt.load)
    const project = join(root, 'projeto-sweep')
    mkdirSync(project, { recursive: true })
    const plan = (base: Parameters<Parameters<ProjectSandbox['wrapWith']>[2]>[0]) => cercoPlan({}, { ...base, system: [] })
    writeFileSync(join(project, 'package.json'), '')
    await sandbox.wrapWith('ls', project, plan, 'tok-a')
    assert.ok(!existsSync(join(project, 'package.json')), 'antes do primeiro comando')
    // Com o A rodando, o segundo comando não varre (soltaria a negação do A).
    writeFileSync(join(project, '.npmrc'), '')
    await sandbox.wrapWith('ls', project, plan, 'tok-b')
    assert.ok(existsSync(join(project, '.npmrc')), 'com outro rodando, nada se apaga')
    sandbox.done()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(existsSync(join(project, '.npmrc')), 'ainda há um rodando')
    sandbox.done()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(!existsSync(join(project, '.npmrc')), 'o último saiu: varre')
  })

  it('⛔ comando cercado que falha ao embrulhar não deixa a conta aberta (a varredura segue valendo)', async () => {
    const srt = fakeSrt()
    const sandbox = new ProjectSandbox(env, srt.load)
    const project = join(root, 'projeto-falha')
    mkdirSync(project, { recursive: true })
    await assert.rejects(() =>
      sandbox.wrapWith(
        'ls',
        project,
        () => {
          throw new Error('plano quebrou')
        },
        'tok-f',
      ),
    )
    writeFileSync(join(project, 'bunfig.toml'), '')
    await sandbox.wrapWith('ls', project, (base) => cercoPlan({}, { ...base, system: [] }), 'tok-g')
    assert.ok(!existsSync(join(project, 'bunfig.toml')))
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

  it('⚖️ desce em repositório e worktree aninhados (os .env.example de lá ficavam trocados por /dev/null); pula node_modules e .git', () => {
    mkdirSync(join(root, '.agents', 'skills', 'x'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'x', '.env.example'), 'A=')
    // Repositório aninhado (com `.git` de verdade) e a worktree dele (`.git` é arquivo).
    mkdirSync(join(root, 'repositories', 'logiccus', '.git'), { recursive: true })
    mkdirSync(join(root, 'repositories', 'logiccus', 'apis', 'logiccus'), { recursive: true })
    writeFileSync(join(root, 'repositories', 'logiccus', 'apis', 'logiccus', '.env.example'), 'A=')
    writeFileSync(join(root, 'repositories', 'logiccus', '.git', '.env.example'), 'nunca')
    mkdirSync(join(root, 'repositories', 'logiccus', '_worktrees', 'EP-1', 'apps'), { recursive: true })
    writeFileSync(join(root, 'repositories', 'logiccus', '_worktrees', 'EP-1', '.git'), 'gitdir: ../../.git/worktrees/EP-1')
    writeFileSync(join(root, 'repositories', 'logiccus', '_worktrees', 'EP-1', 'apps', '.env.example'), 'A=')
    mkdirSync(join(root, 'repositories', 'logiccus', 'node_modules', 'p'), { recursive: true })
    writeFileSync(join(root, 'repositories', 'logiccus', 'node_modules', 'p', '.env.example'), 'nunca')
    writeFileSync(join(root, 'repositories', 'logiccus', 'apis', 'logiccus', '.env'), 'SEGREDO=1')
    // As worktrees entram DEPOIS da árvore principal (o teto corta por elas): o `git diff` na worktree via /dev/null.
    assert.deepStrictEqual(findUnder(root, '**/.env.*'), [
      '.agents/skills/x/.env.example',
      'repositories/logiccus/apis/logiccus/.env.example',
      'repositories/logiccus/_worktrees/EP-1/apps/.env.example',
    ])
    // Na conversa dentro da worktree, a raiz é ela: os modelos dela entram.
    assert.deepStrictEqual(findUnder(join(root, 'repositories', 'logiccus', '_worktrees', 'EP-1'), '**/.env.*'), ['apps/.env.example'])
  })

  it('⛔ passou do teto de modelos, o resto fica escondido; os da árvore principal vêm antes dos das worktrees', () => {
    const many = join(root, 'muitos')
    for (let i = 0; i < 10; i += 1) {
      mkdirSync(join(many, `d${i}`), { recursive: true })
      writeFileSync(join(many, `d${i}`, '.env.example'), 'A=')
    }
    for (let i = 0; i < 400; i += 1) {
      mkdirSync(join(many, '_worktrees', `EP-${i}`), { recursive: true })
      writeFileSync(join(many, '_worktrees', `EP-${i}`, '.env.example'), 'A=')
    }
    const found = findUnder(many, '**/.env.*')
    assert.strictEqual(found.length, 400)
    assert.deepStrictEqual(found.slice(0, 10).sort(), Array.from({ length: 10 }, (_, i) => `d${i}/.env.example`).sort())
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

describe('CERCO_READ_ALLOWLIST — o cerco lê só o liberado', () => {
  const dataEnv = (extra: Record<string, string> = {}) => ({ CONVERSATIONS_DB: '/srv/gw/gateway.db', ...extra }) as NodeJS.ProcessEnv
  const load = async () => ({ SandboxManager: {} as never })

  it('desligada (padrão) ou fora do Linux: a base não traz lista', () => {
    assert.strictEqual(new ProjectSandbox(dataEnv(), load, 'linux').base('/srv/gw/projects/x').readAllowlist, undefined)
    assert.strictEqual(new ProjectSandbox(dataEnv({ CERCO_READ_ALLOWLIST: '1' }), load, 'darwin').base('/srv/gw/projects/x').readAllowlist, undefined)
    assert.strictEqual(new ProjectSandbox(dataEnv({ CERCO_READ_ALLOWLIST: '0' }), load, 'linux').base('/srv/gw/projects/x').readAllowlist, undefined)
  })

  it('ligada no Linux: o plano fecha `/` e o bubblewrap fecha cada irmão fora da lista, sem tocar /proc e /dev', () => {
    const sandbox = new ProjectSandbox(dataEnv({ CERCO_READ_ALLOWLIST: '1' }), load, 'linux')
    const base = { ...sandbox.base('/srv/gw/projects/x'), readAllowlist: ['/usr', '/bin', '/etc/ssl', '/etc/resolv.conf'] }
    const plan = cercoPlan({}, base)
    assert.ok(plan.readDeny.includes('/'))
    const tree: Record<string, string[]> = {
      '/': ['usr', 'bin', 'etc', 'opt', 'home', 'proc', 'dev', 'sys', 'srv', 'var'],
      '/etc': ['ssl', 'hostname', 'resolv.conf', 'passwd'],
      '/srv': ['gw'],
      '/srv/gw': ['gateway.db', 'projects'],
      '/srv/gw/projects': ['x', 'y'],
    }
    const linux = forBubblewrap({ ...plan, readDeny: ['/'] }, '/srv/gw/projects/x', (dir) => tree[dir] ?? [])
    // O que o plano reabre da máquina (o Node em uso, a pasta da CI) fica aberto: só o resto entra na prova de "fechado".
    const reopened = (dir: string) => plan.readAllow.some((path) => path.replace(/\/\*\*$/, '').startsWith(`${dir}/`))
    for (const closed of ['/opt', '/home', '/var', '/etc/hostname', '/etc/passwd', '/srv/gw/gateway.db', '/srv/gw/projects/y'].filter((dir) => !reopened(dir)))
      assert.ok(linux.readDeny.includes(closed), closed)
    for (const open of ['/', '/usr', '/bin', '/etc', '/etc/ssl', '/etc/resolv.conf', '/proc', '/dev', '/sys', '/srv/gw/projects/x']) assert.ok(!linux.readDeny.includes(open), open)
  })

  it('a lista do sistema: só o que existe, com os prefixos de /etc expandidos e o Node em uso', () => {
    const present = new Set(['/usr', '/bin', '/etc/ssl', '/etc/hosts', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/ssh/ssh_config', '/home/u/.nvm/v22'])
    const list = systemReadAllowlist(
      (p) => present.has(p),
      (dir) => (dir === '/etc' ? ['ld.so.conf', 'ld.so.conf.d', 'hostname'] : []),
      '/home/u/.nvm/v22/bin/node',
    )
    assert.deepStrictEqual(list.sort(), ['/bin', '/etc/hosts', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/ssh/ssh_config', '/etc/ssl', '/home/u/.nvm/v22', '/usr'])
    assert.ok(!list.includes('/etc/hostname') && !list.includes('/etc/shadow'))
  })
})

describe('sweepMountPoints — as sobras de ponto de montagem na pasta do projeto', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-sweep-'))
  after(() => rmSync(base, { recursive: true, force: true }))

  it('⛔ apaga só arquivo VAZIO e pasta vazia da lista exata, e registra o que apagou', () => {
    const dir = join(base, 'projeto')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    for (const name of ['bunfig.toml', '.env', '.env.development.local', '.env.test', '.npmrc', '.gitmodules', 'package.json']) writeFileSync(join(dir, name), '')
    writeFileSync(join(dir, 'outro-vazio.txt'), '')
    const log: string[] = []
    const removed = sweepMountPoints(dir, (message) => log.push(message))
    for (const name of ['bunfig.toml', '.env', '.env.development.local', '.env.test', '.npmrc', '.gitmodules', 'package.json', 'node_modules', '.claude'])
      assert.ok(!existsSync(join(dir, name)), name)
    assert.ok(existsSync(join(dir, 'outro-vazio.txt')), 'fora da lista fica')
    assert.ok(removed.includes(join(dir, 'package.json')) && removed.includes(join(dir, 'node_modules')))
    assert.strictEqual(log.length, 1)
    assert.match(log[0]!, /package\.json/)
  })

  it('⛔ o que tem conteúdo, a pasta cheia e o link ficam', () => {
    const dir = join(base, 'cheio')
    mkdirSync(join(dir, 'node_modules', 'pacote'), { recursive: true })
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    writeFileSync(join(dir, '.env'), 'SEGREDO=1')
    const alvo = join(base, 'alvo-vazio')
    writeFileSync(alvo, '')
    symlinkSync(alvo, join(dir, '.npmrc'))
    const log: string[] = []
    assert.deepStrictEqual(
      sweepMountPoints(dir, (message) => log.push(message)),
      [],
    )
    assert.deepStrictEqual(log, [])
    for (const name of ['node_modules/pacote', '.claude/settings.json', 'package.json', '.env']) assert.ok(existsSync(join(dir, name)), name)
    assert.ok(existsSync(alvo), 'o alvo do link fica')
    assert.ok(readFileSync(join(dir, 'package.json'), 'utf8').includes('"x"'))
  })

  it('⛔ dentro de repositório, arquivo vazio que o git rastreia nunca sai; o não rastreado sai', () => {
    const dir = join(base, 'repo')
    mkdirSync(dir, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q')
    writeFileSync(join(dir, '.gitmodules'), '')
    git('add', '.gitmodules')
    writeFileSync(join(dir, 'bunfig.toml'), '')
    assert.deepStrictEqual(
      sweepMountPoints(dir, () => undefined).map((path) => path.slice(dir.length + 1)),
      ['bunfig.toml'],
    )
    assert.ok(existsSync(join(dir, '.gitmodules')))
  })

  it('pasta que não existe, ou é link, não quebra nem é seguida', () => {
    assert.deepStrictEqual(sweepMountPoints(join(base, 'nao-existe')), [])
    const real = join(base, 'real')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'package.json'), '')
    symlinkSync(real, join(base, 'link'))
    assert.deepStrictEqual(sweepMountPoints(join(base, 'link')), [])
    assert.ok(existsSync(join(real, 'package.json')))
  })
})
