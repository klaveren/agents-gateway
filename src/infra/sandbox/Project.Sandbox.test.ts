import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { forBubblewrap, ProjectSandbox, projectPathIssue } from './Project.Sandbox'

describe('ProjectSandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-sandbox-test-'))
  const env = { CONVERSATIONS_DB: join(root, 'gateway.db') } as NodeJS.ProcessEnv
  after(() => rmSync(root, { recursive: true, force: true }))

  const fakeSrt = (fail?: string) => {
    const calls: Array<{ command: string; config?: Record<string, unknown> }> = []
    return {
      calls,
      load: async () => ({
        SandboxManager: {
          initialize: async () => undefined,
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
    assert.deepStrictEqual(policy.filesystem.denyRead, [root, process.cwd(), homedir()])
    assert.deepStrictEqual(policy.filesystem.allowRead.slice(0, 2), [project, join(root, 'tools')])
    // E só o auxiliar de seccomp do srt, que mora em `node_modules` (dentro do app, que fica fechado).
    assert.ok(policy.filesystem.allowRead.slice(2).every((path) => /sandbox-runtime[/\\]vendor[/\\]seccomp$/.test(path)))
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
