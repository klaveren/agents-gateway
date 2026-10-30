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

  it('comando por palavras; o nome pela base, para /bin/rm não escapar de rm', () => {
    assert.ok(commandMatches('git *', ['git']))
    assert.ok(commandMatches('git *', ['git', 'push', '-f']))
    assert.ok(!commandMatches('git', ['git', 'status']))
    assert.ok(commandMatches('npm run test*', ['npm', 'run', 'test:unit']))
    assert.ok(commandMatches('rm *', ['/bin/rm', '-rf', 'x']))
    assert.ok(commandMatches('git push * main', ['git', 'push', '--force', 'origin', 'main']))
    assert.ok(!commandMatches('git push * main', ['git', 'push', 'origin', 'dev']))
    assert.ok(commandMatches('*', ['qualquer', 'coisa']))
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
