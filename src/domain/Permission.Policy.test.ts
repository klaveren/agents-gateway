import assert from 'node:assert'
import { describe, it } from 'node:test'
import { commandMatches, decide, hostMatches, IPermissionRule, pathMatches, permissionIssues } from './Permission.Policy'

const rule = (category: IPermissionRule['category'], pattern: string, decision: IPermissionRule['decision'] = 'allow'): IPermissionRule => ({ category, pattern, decision })
const cmd = (text: string) => ({ category: 'terminal' as const, value: text, argv: text.split(' ') })

describe('Permission.Policy', () => {
  it('sem regra, negado; o projeto fecha e o agente libera; dentro da camada, negar vence permitir', () => {
    assert.strictEqual(decide(cmd('git status'), {}).layer, 'default')
    // `**` no terminal casa uma palavra só: o salvamento recusa e manda usar `*`.
    assert.ok(decide(cmd('ls'), { project: [{ category: 'terminal', pattern: '**', decision: 'allow' }] }).allowed)
    assert.ok(!decide(cmd('cat x'), { project: [{ category: 'terminal', pattern: '**', decision: 'allow' }] }).allowed)
    assert.match(permissionIssues([{ category: 'terminal', pattern: 'git **', decision: 'allow' }])[0]?.message ?? '', /use \*/)
    assert.deepStrictEqual(
      permissionIssues([
        { category: 'read', pattern: 'apps/**', decision: 'allow' },
        { category: 'terminal', pattern: 'git *', decision: 'allow' },
      ]),
      [],
    )
    // O repositório do projeto vale sem regra; Negar restringe.
    const repo = { category: 'repository' as const, value: 'logiccus' }
    assert.deepStrictEqual([decide(repo, {}).allowed, decide(repo, {}).layer], [true, 'default'])
    assert.strictEqual(decide(repo, { agent: [{ category: 'repository', pattern: 'logiccus', decision: 'deny' }] }).allowed, false)
    assert.strictEqual(decide(cmd('git status'), {}).allowed, false)

    const project = [rule('terminal', 'git *'), rule('terminal', 'git push *', 'deny')]
    assert.strictEqual(decide(cmd('git status'), { project }).allowed, true)
    assert.strictEqual(decide(cmd('git push origin main'), { project }).allowed, false)

    // O agente libera o que o projeto negou — e a regra de negar dele, na mesma camada, vence a de permitir.
    const agent = [rule('terminal', 'git push origin *'), rule('terminal', 'git push origin main', 'deny')]
    assert.strictEqual(decide(cmd('git push origin feature/x'), { project, agent }).allowed, true)
    const main = decide(cmd('git push origin main'), { project, agent })
    assert.deepStrictEqual([main.allowed, main.layer, main.rule?.pattern], [false, 'agent', 'git push origin main'])
  })

  it('⛔ o mesmo arquivo por duas pastas-base: a regra casa com qualquer uma, e a negação continua vencendo', () => {
    const layers = {
      agent: [
        { category: 'write' as const, pattern: 'repositories/logiccus/_worktrees/*/**/*.test.ts', decision: 'allow' as const },
        { category: 'write' as const, pattern: 'packages/validator/**', decision: 'deny' as const },
      ],
    }
    const write = (value: string, aliases: string[]) => decide({ category: 'write', value, aliases }, layers).allowed
    assert.ok(write('mcps/x/a.test.ts', ['repositories/logiccus/_worktrees/EP-1/mcps/x/a.test.ts']), 'a regra do projeto vale dentro da worktree')
    assert.ok(!write('mcps/x/a.test.ts', []), 'sem a outra forma, como antes')
    assert.ok(!write('packages/validator/a.test.ts', ['repositories/logiccus/_worktrees/EP-1/packages/validator/a.test.ts']), 'a negação pela worktree vence')
    assert.ok(!write('apis/x.ts', ['repositories/logiccus/_worktrees/EP-1/apis/x.ts']), 'fora do padrão, segue negado')
  })

  it('⛔ a camada sistema é final: nem o agente com * levanta', () => {
    const agent = [rule('read', '**'), rule('terminal', '*')]
    for (const path of ['.env', 'apps/api/.env.local', 'deploy/server.pem', 'home/id_rsa']) {
      const verdict = decide({ category: 'read', value: path }, { agent })
      assert.deepStrictEqual([verdict.allowed, verdict.layer], [false, 'system'], path)
    }
    assert.strictEqual(decide(cmd('sudo ls'), { agent }).layer, 'system')
    assert.strictEqual(decide({ category: 'terminal', value: 'sh', argv: ['sh'] }, { agent }).layer, 'system')
    // Regra de sistema da instalação (a pasta de dados, absoluta).
    const extra = [rule('read', '/srv/gateway/data/**', 'deny')]
    assert.strictEqual(decide({ category: 'read', value: '/srv/gateway/data/gateway.db' }, { agent: [rule('read', '/srv/**')] }, extra).layer, 'system')
  })

  it('⚖️ segredo de verdade negado; o MODELO (`.env.example`…) e o código `secrets.js` não', () => {
    const agent = [rule('read', '**'), rule('write', '**')]
    const read = (value: string) => decide({ category: 'read', value }, { agent })
    for (const path of [
      '.env',
      '.env.local',
      'apps/.env.production',
      'conf/secrets.json',
      'secrets.yaml',
      'secrets.env',
      'k.key',
      'repositories/logiccus/.credentials/automation/agents-gateway.env',
      'x/.credentials/token.txt',
    ])
      assert.deepStrictEqual([read(path).allowed, read(path).layer], [false, 'system'], path)
    for (const path of [
      'infra/profiles/default.env',
      '.env.example',
      'apps/.env.local.example',
      '.env.sample',
      'x/.env.template',
      '.env.dist',
      'lib/secrets.js',
      'bin/secrets.sh',
      'secrets.ts',
    ])
      assert.strictEqual(read(path).allowed, true, path)
    assert.strictEqual(decide({ category: 'write', value: '.env.example' }, { agent }).allowed, true)
    // A negação de uma camada que cobre o modelo continua valendo.
    assert.strictEqual(decide({ category: 'read', value: '.env.example' }, { agent: [rule('read', '**/.env*', 'deny'), ...agent] }).allowed, false)
  })

  it('comando por palavras; o nome pela base, para /bin/rm não escapar de rm', () => {
    assert.ok(commandMatches('git *', ['git']))
    assert.ok(commandMatches('git *', ['git', 'push', '-f']))
    assert.ok(!commandMatches('git', ['git', 'status']))
    assert.ok(commandMatches('npm run test*', ['npm', 'run', 'test:unit']))
    // O `*` colado na última palavra é prefixo do comando: `git status*` cobre `git status --short` (o `**` segue uma palavra).
    assert.ok(commandMatches('git status*', ['git', 'status', '--short']))
    assert.ok(commandMatches('git status*', ['git', 'status']))
    assert.ok(!commandMatches('git status*', ['git', 'stash', 'pop']))
    assert.ok(!commandMatches('git st*tus x', ['git', 'status', 'x', 'y']))
    assert.ok(commandMatches('rm *', ['/bin/rm', '-rf', 'x']))
    assert.ok(commandMatches('git push * main', ['git', 'push', '--force', 'origin', 'main']))
    assert.ok(!commandMatches('git push * main', ['git', 'push', 'origin', 'dev']))
    assert.ok(commandMatches('*', ['qualquer', 'coisa']))
  })

  it('⛔ NEGAR vale com as opções globais no meio (`git -C . push`, `kubectl -n prod delete`); LIBERAR segue literal', () => {
    const verdict = (agent: IPermissionRule[], argv: string[]) => decide({ category: 'terminal', value: argv.join(' '), argv }, { agent }).allowed
    const git = [rule('terminal', 'git *'), rule('terminal', 'git push *', 'deny')]
    for (const argv of [
      ['git', 'push', 'origin', 'main'],
      ['git', '-C', '.', 'push', 'origin', 'main'],
      ['git', '--no-pager', 'push'],
      ['git', '-c', 'core.pager=cat', 'push', 'x'],
      ['git', '--git-dir=.git', '--work-tree=.', 'push', 'x'],
      ['git', '--git-dir', '.git', 'push', 'x'],
      ['git', '-P', '--bare', 'push'],
      ['git', '-c', 'alias.p=push', 'p', 'origin', 'main'],
      ['git', '-calias.p=push', 'p', 'origin'],
      ['/usr/bin/git', '-C', '/x', 'push'],
    ])
      assert.strictEqual(verdict(git, argv), false, argv.join(' '))
    assert.strictEqual(verdict(git, ['git', '-C', '.', 'status']), true)
    assert.strictEqual(verdict(git, ['git', '--no-pager', 'log']), true)
    const kube = [rule('terminal', 'kubectl *'), rule('terminal', 'kubectl delete *', 'deny')]
    for (const argv of [
      ['kubectl', 'delete', 'pod', 'x'],
      ['kubectl', '-n', 'prod', 'delete', 'pod', 'x'],
      ['kubectl', '--namespace=prod', 'delete', 'pod', 'x'],
      ['kubectl', '--context', 'prod', '--kubeconfig', '/k', 'delete', 'pod', 'x'],
    ])
      assert.strictEqual(verdict(kube, argv), false, argv.join(' '))
    assert.strictEqual(verdict(kube, ['kubectl', '-n', 'prod', 'get', 'pods']), true)
    for (const argv of [
      ['docker', '-H', 'tcp://x', 'rm', 'a'],
      ['helm', '-n', 'p', 'uninstall', 'r'],
      ['systemctl', '--user', 'stop', 'x'],
    ]) {
      const rules = [rule('terminal', '*'), rule('terminal', `${argv[0]} ${argv.includes('rm') ? 'rm' : argv.includes('uninstall') ? 'uninstall' : 'stop'} *`, 'deny')]
      assert.strictEqual(verdict(rules, argv), false, argv.join(' '))
    }
    // LIBERAR não alarga: a regra `git push *` não libera a opção global, nem o apelido.
    assert.strictEqual(verdict([rule('terminal', 'git push *')], ['git', '-C', '.', 'push', 'x']), false)
    assert.strictEqual(verdict([rule('terminal', 'git *')], ['git', '-c', 'alias.p=push', 'p']), false)
  })

  it('⛔ liberação relativa só vale dentro da pasta: `**` não alcança caminho absoluto nem ~; a negação vale em todo lugar', () => {
    const agent = [rule('write', '**'), rule('read', '**'), rule('read', '/opt/dados/**')]
    for (const value of ['/etc/passwd', '/app/data/projects/p1/repositories/abc/.git/hooks/pre-commit', '~/.ssh/config'])
      assert.strictEqual(decide({ category: 'write', value }, { agent }).allowed, false, value)
    assert.strictEqual(decide({ category: 'write', value: 'apps/x.ts' }, { agent }).allowed, true)
    assert.strictEqual(decide({ category: 'read', value: '/opt/dados/a.csv' }, { agent }).allowed, true, 'liberação absoluta abre fora')
    assert.strictEqual(decide({ category: 'read', value: '/srv/x/.env' }, { agent: [rule('read', '/srv/**')] }).allowed, false, 'o segredo continua negado fora')
  })

  it('caminho em glob; sem barra, o nome em qualquer pasta; absoluto e ~ para fora da pasta', () => {
    assert.ok(pathMatches('apps/**', 'apps/web/src/main.ts'))
    assert.ok(!pathMatches('apps/**', 'packages/x.ts'))
    assert.ok(pathMatches('src/*.ts', 'src/a.ts') && !pathMatches('src/*.ts', 'src/deep/a.ts'))
    assert.ok(pathMatches('**/*.test.ts', 'a/b/c.test.ts') && pathMatches('**/*.test.ts', 'c.test.ts'))
    assert.ok(pathMatches('*.md', 'docs/README.md'))
    assert.ok(pathMatches('/home/sre/.ssh/logiccus', '/home/sre/.ssh/logiccus'))
  })

  it('destino de rede com subdomínio e porta', () => {
    assert.ok(hostMatches('*.logiccus.com', 'api.logiccus.com'))
    assert.ok(!hostMatches('*.logiccus.com', 'logiccus.com.evil.io'))
    assert.ok(hostMatches('prod.logiccus.com:22', 'prod.logiccus.com:22'))
    assert.ok(!hostMatches('prod.logiccus.com:22', 'prod.logiccus.com:443'))
    assert.ok(hostMatches('github.com', 'github.com:443'))
  })

  it('⚖️ a regra exata decide antes do curinga, em qualquer ordem (o portão exige a exata para a rede local)', () => {
    const agent: IPermissionRule[] = [
      { category: 'network', pattern: '*', decision: 'allow' },
      { category: 'network', pattern: '10.10.0.2:22', decision: 'allow' },
    ]
    assert.strictEqual(decide({ category: 'network', value: '10.10.0.2:22' }, { agent }).rule?.pattern, '10.10.0.2:22')
    assert.strictEqual(decide({ category: 'network', value: 'api.github.com:443' }, { agent }).rule?.pattern, '*')
  })

  it('na lite, delegar sem regra é liberado (marcar o agente basta); na PRO, segue pedindo regra; negar vence nas duas', () => {
    assert.ok(!decide({ category: 'delegate', value: 'pesquisa' }, {}).allowed)
    process.env.GATEWAY_EDITION = 'lite'
    try {
      assert.ok(decide({ category: 'delegate', value: 'pesquisa' }, {}).allowed)
      assert.ok(!decide({ category: 'delegate', value: 'pesquisa' }, { agent: [rule('delegate', 'pesquisa', 'deny')] }).allowed)
    } finally {
      delete process.env.GATEWAY_EDITION
    }
  })

  it('MCP sem regra é liberado (a escolha na guia MCPs é a liberação); a regra de negar ainda restringe', () => {
    const open = decide({ category: 'mcp', value: 'playwright/browser_navigate' }, {})
    assert.deepStrictEqual([open.allowed, open.layer], [true, 'default'])
    assert.ok(!decide({ category: 'mcp', value: 'playwright/browser_navigate' }, { agent: [rule('mcp', 'playwright/browser_*', 'deny')] }).allowed)
    assert.ok(!decide({ category: 'terminal', value: 'ls' }, {}).allowed)
  })

  it('MCP, skill e delegação por glob no nome', () => {
    assert.ok(decide({ category: 'mcp', value: 'logiccus/ticket_get' }, { project: [rule('mcp', 'logiccus/ticket_*')] }).allowed)
    assert.ok(!decide({ category: 'mcp', value: 'logiccus/meeting_create' }, { project: [rule('mcp', 'logiccus/*'), rule('mcp', 'logiccus/meeting_create', 'deny')] }).allowed)
    assert.ok(decide({ category: 'skill', value: 'akm-research' }, { agent: [rule('skill', 'akm-*')] }).allowed)
    assert.ok(!decide({ category: 'delegate', value: 'agent-god' }, { agent: [rule('delegate', 'agent-*'), rule('delegate', 'agent-god', 'deny')] }).allowed)
  })

  it('o salvamento recusa regra sem padrão, categoria desconhecida e decisão inválida', () => {
    assert.deepStrictEqual(permissionIssues([rule('terminal', 'ls')]), [])
    const issues = permissionIssues([{ category: 'x', pattern: '', decision: 'talvez' }])
    assert.strictEqual(issues.length, 3)
  })
})
