import assert from 'node:assert'
import { describe, it } from 'node:test'
import { cercoPlan, projectAnchored, toSandboxPath } from './Cerco.Plan'
import { IPermissionRule } from './Permission.Policy'

const rule = (category: IPermissionRule['category'], pattern: string, decision: IPermissionRule['decision'] = 'allow'): IPermissionRule => ({ category, pattern, decision })
const base = { root: '/w/p', scratch: ['/w/p/.home', '/w/p/.tmp'], alwaysRead: ['/tools'], alwaysDeny: ['/home/gw', '/srv/data', '/w'] }

describe('Cerco.Plan', () => {
  it('padrão relativo vira absoluto na raiz; sem barra vale em qualquer pasta; absoluto e ~ ficam', () => {
    assert.strictEqual(toSandboxPath('apps/**', '/w/p'), '/w/p/apps/**')
    assert.strictEqual(toSandboxPath('*.env', '/w/p'), '/w/p/**/*.env')
    assert.strictEqual(toSandboxPath('/etc/hosts', '/w/p'), '/etc/hosts')
    assert.strictEqual(toSandboxPath('~/.ssh/key', '/w/p'), '~/.ssh/key')
  })

  it('⛔ worktree: a raiz é a worktree, o rascunho no projeto, o .git comum aberto, menos config e hooks', () => {
    const plan = cercoPlan(
      { agent: [rule('write', 'apps/**')] },
      { ...base, root: '/w/p/repositories/abc/_worktrees/EP-1', scratch: ['/w/p/.home', '/w/p/.tmp'], gitCommonDir: '/w/p/repositories/abc/.git' },
    )
    assert.ok(plan.readDeny.includes('/w/p/repositories/abc/_worktrees/EP-1'))
    assert.ok(plan.writeAllow.includes('/w/p/repositories/abc/_worktrees/EP-1/apps/**'))
    assert.ok(plan.readAllow.includes('/w/p/repositories/abc/.git') && plan.writeAllow.includes('/w/p/repositories/abc/.git'))
    for (const path of ['/w/p/repositories/abc/.git/config', '/w/p/repositories/abc/.git/hooks', '/w/p/repositories/abc/.git/worktrees/*/config.worktree'])
      assert.ok(plan.writeDeny.includes(path), path)
    assert.ok(!plan.readAllow.some((path) => path === '/w/p/repositories/abc'), 'o checkout principal fica fora')
  })

  it('⛔ o que diz onde está o git (e o que roda no git de fora) nunca se grava: comum, modules, atributos e, na worktree, .git/commondir/gitdir', () => {
    const common = '/w/p/repositories/abc/.git'
    const tree = '/w/p/repositories/abc/_worktrees/EP-1'
    const gitDir = `${common}/worktrees/EP-1`
    const worktree = cercoPlan({ agent: [rule('write', '**')] }, { ...base, root: tree, gitCommonDir: common, worktreeGitDir: gitDir })
    for (const path of [
      `${common}/config`,
      `${common}/config.worktree`,
      `${common}/hooks`,
      `${common}/modules`,
      `${common}/info/attributes`,
      `${tree}/.git`,
      `${gitDir}/commondir`,
      `${gitDir}/gitdir`,
      `${gitDir}/config.worktree`,
    ])
      assert.ok(worktree.writeDeny.includes(path), path)
    // Só repositório: o `.git` fica dentro da raiz; sem os caminhos da worktree.
    const only = cercoPlan({}, { ...base, root: '/w/p/repositories/abc', gitCommonDir: common })
    assert.ok(only.writeDeny.includes(`${common}/modules`) && only.writeDeny.includes(`${common}/info/attributes`))
    assert.ok(!only.writeDeny.some((path) => path.endsWith('/commondir')))
  })

  it('⚖️ repositório ou worktree: a regra escrita da pasta do projeto também vale, levada para dentro da raiz', () => {
    const repo = '/w/p/repositories/abc'
    const tree = `${repo}/_worktrees/EP-1`
    assert.strictEqual(projectAnchored('repositories/abc/infra/**', repo, '/w/p'), `${repo}/infra/**`)
    assert.strictEqual(projectAnchored('repositories/abc/_worktrees/*/evidence/**', tree, '/w/p'), `${tree}/evidence/**`)
    assert.strictEqual(projectAnchored('repositories/**', tree, '/w/p'), `${tree}/**`)
    // Não chega à raiz, vale em qualquer pasta, é absoluto, ou a raiz é o projeto: nada.
    for (const [pattern, root] of [
      ['repositories/outro/infra/**', repo],
      ['tmp/agents/**', repo],
      ['repositories/abc/_worktrees/EP-2/**', tree],
      ['*.md', repo],
      ['**/logs/**', repo],
      ['/etc/x', repo],
      ['apps/**', '/w/p'],
    ] as const)
      assert.strictEqual(projectAnchored(pattern, root, '/w/p'), undefined, pattern)
    assert.strictEqual(projectAnchored('repositories/abc/infra/**', repo, undefined), undefined)

    const plan = cercoPlan(
      { agent: [rule('write', 'repositories/abc/infra/**')], project: [rule('write', 'repositories/abc/.git/hooks/**', 'deny')] },
      { ...base, root: repo, projectRoot: '/w/p', gitCommonDir: `${repo}/.git` },
    )
    assert.ok(plan.writeAllow.includes(`${repo}/infra/**`))
    assert.ok(!plan.writeAllow.includes(`${repo}/repositories/abc/infra/**`), 'a liberação não cria a pasta vazia na raiz')
    assert.ok(plan.writeDeny.includes(`${repo}/.git/hooks/**`), 'a negação também é levada')
    assert.ok(plan.writeDeny.includes(`${repo}/repositories/abc/.git/hooks/**`), 'e a negação segue ancorada na raiz (falha fechada)')
  })

  it('⛔ as pastas só leitura (arquivos de recurso): lidas sempre, gravadas nunca — nem com regra de escrita que as cubra', () => {
    const plan = cercoPlan({ agent: [rule('write', '**')] }, { ...base, readOnly: ['/w/p/skills', '/srv/data/global'] })
    for (const path of ['/w/p/skills', '/srv/data/global']) {
      assert.ok(plan.readAllow.includes(path), path)
      assert.ok(plan.writeDeny.includes(path), path)
    }
    assert.ok(plan.writeAllow.includes('/w/p/**'))
  })

  it('sem regra: a raiz fechada para leitura e escrita, só as pastas de trabalho abertas; segredos sempre negados', () => {
    const plan = cercoPlan({}, base)
    assert.ok(plan.readDeny.includes('/w/p') && plan.readDeny.includes('/home/gw'))
    assert.deepStrictEqual(plan.writeAllow, ['/w/p/.home', '/w/p/.tmp'])
    assert.ok(plan.writeDeny.includes('/w/p/**/.env') && plan.readDeny.includes('/w/p/**/*.pem'))
    // A que contém a raiz fica na leitura (a raiz reabre por dentro) e sai da escrita (negar venceria tudo).
    assert.ok(plan.readDeny.includes('/w') && !plan.writeDeny.includes('/w') && plan.writeDeny.includes('/srv/data'))
  })

  it('⚖️ o modelo de segredo que a regra deixa ler é reaberto um a um (o runtime não nega no padrão); o resto, não', () => {
    const files: Record<string, string[]> = { '**/.env.*': ['.env.local', '.env.example', 'apps/.env.local.example', 'infra/.env.sample'] }
    const find = (pattern: string) => files[pattern] ?? []
    const plan = cercoPlan({ agent: [rule('read', '**'), rule('read', 'infra/**', 'deny')] }, { ...base, find })
    assert.ok(plan.readDeny.includes('/w/p/**/.env.*'), 'o padrão segue negado')
    assert.ok(plan.readAllow.includes('/w/p/.env.example') && plan.readAllow.includes('/w/p/apps/.env.local.example'))
    assert.ok(!plan.readAllow.includes('/w/p/.env.local'), 'o segredo não')
    assert.ok(!plan.readAllow.includes('/w/p/infra/.env.sample'), 'a negação da camada vale')
    assert.ok(!plan.writeAllow.some((path) => path.includes('.env')), 'a escrita não abre')
    assert.ok(plan.readDeny.includes('/w/p/**/secrets.json') && !plan.readDeny.some((path) => path.endsWith('secrets.*')))
  })

  it('as liberações das camadas abrem; a negação do projeto que o agente reabriu por dentro sai; a outra fica', () => {
    const plan = cercoPlan(
      {
        project: [rule('write', 'apps/**'), rule('write', 'infra/**', 'deny'), rule('write', 'secrets/**', 'deny'), rule('read', '**')],
        agent: [rule('write', 'infra/k8s/**'), rule('read', '~/.ssh/logiccus'), rule('write', 'apps/legacy/**', 'deny')],
      },
      base,
    )
    assert.ok(plan.writeAllow.includes('/w/p/apps/**') && plan.writeAllow.includes('/w/p/infra/k8s/**'))
    assert.ok(!plan.writeDeny.includes('/w/p/infra/**'), 'reaberta pelo agente')
    assert.ok(plan.writeDeny.includes('/w/p/secrets/**') && plan.writeDeny.includes('/w/p/apps/legacy/**'))
    assert.ok(plan.readAllow.includes('/w/p/**') && plan.readAllow.includes('~/.ssh/logiccus'))
  })
})
