import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { decide, type IPermissionRule } from '@domain/Permission.Policy'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { transportRefusal } from './Bash.Guard'
import { terminalRefusal } from './Local.Tools'

const rule = (pattern: string, decision: IPermissionRule['decision']): IPermissionRule => ({ category: 'terminal', pattern, decision })

const checker = (rules: IPermissionRule[]): IPermissionChecker => ({
  check: (_asker, subject) => decide(subject, { project: rules }),
  layers: () => ({ system: [], project: rules }),
})

const refusal = (command: string, rules: IPermissionRule[]) => terminalRefusal(command, '/w', checker(rules), {})

describe('terminal — apelido do git contra a negação', () => {
  const rules = [rule('git *', 'allow'), rule('git push *', 'deny'), rule('ls *', 'allow'), rule('ls', 'allow')]

  it('⛔ `git p origin main` (apelido de push gravado no .gitconfig) casa o deny de push; o push direto também', async () => {
    assert.ok(await refusal('git push origin main', rules))
    assert.ok(await refusal('git p origin main', rules))
    assert.ok(await refusal('git -C . p origin main', rules))
    assert.ok(await refusal('git --no-pager p', rules))
  })

  it('o uso legítimo segue: subcomandos do git, opções globais com valor, versão', async () => {
    for (const command of ['git status', 'git -C sub log --oneline', 'git -c user.name=x commit -m y', 'git --version', 'git diff HEAD', 'git stash pop', 'git submodule update']) {
      assert.strictEqual(await refusal(command, rules), undefined, command)
    }
  })

  it('sem negação de git, o subcomando desconhecido segue o allow (nada muda para quem não nega)', async () => {
    assert.strictEqual(await refusal('git p origin main', [rule('git *', 'allow')]), undefined)
  })

  it('⛔ `git config alias.*` (local ou --global) é recusado com negação de git ativa, e livre sem ela', async () => {
    for (const command of ['git config alias.p push', 'git config --global alias.p push', 'git config --add alias.p push', 'git -C x config -f .git/config ALIAS.p push']) {
      assert.match((await refusal(command, rules)) ?? '', /apelido/, command)
      assert.strictEqual(await refusal(command, [rule('git *', 'allow')]), undefined, `${command} sem deny`)
    }
    assert.strictEqual(await refusal('git config user.name Maya', rules), undefined)
    assert.match((await refusal('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git status', rules)) ?? '', /apelido/)
  })
})

describe('terminal — o programa que o transporte do ssh lança', () => {
  const refused = async (command: string) => transportRefusal((await analyzeShell(command)).commands, command)

  it('⛔ -o ProxyCommand / LocalCommand que não é ssh simples, em qualquer posição', async () => {
    for (const command of [
      'ssh -o ProxyCommand="sh -c id" host',
      'ssh -o "ProxyCommand=nc %h %p; id" host ls',
      'ssh host -o ProxyCommand=evil ls',
      'ssh -oProxyCommand=evil host',
      'ssh -vo ProxyCommand=evil host',
      'ssh -o LocalCommand="git push" -o PermitLocalCommand=yes host',
      'ssh -o KnownHostsCommand=evil host',
      'ssh -o ProxyCommand="ssh -o ProxyCommand=evil jump" host',
      'ssh -o "$OPT" host',
      'ssh -F /w/cfg host',
      'ssh -o Include=/w/cfg host',
      'scp -o ProxyCommand=evil a host:b',
      'scp -S ./wrapper a host:b',
      'sftp -o ProxyCommand=evil host',
    ])
      assert.ok(await refused(command), command)
  })

  it('o ssh de uso normal segue: opções comuns, ProxyCommand ssh simples ou none, comando remoto com -o dentro', async () => {
    for (const command of [
      'ssh host ls',
      'ssh -p 22 -o BatchMode=yes -o StrictHostKeyChecking=no host uptime',
      'ssh -o ProxyCommand="ssh -W %h:%p jump" host',
      'ssh -o ProxyCommand=none host',
      'ssh host grep -o ProxyCommand file',
      'scp -P 22 -o BatchMode=yes a.txt host:/tmp/',
      'scp -r dir host:/tmp/',
      'rsync -avz dir host:/tmp/',
      'rsync -avz -e "ssh -p 2222 -i key" dir host:/tmp/',
      'rsync -e ssh dir host:/tmp/',
      'git fetch origin',
      'GIT_SSH_COMMAND="ssh -i key -o StrictHostKeyChecking=no" git clone host:repo',
      'git -c core.sshCommand="ssh -i key" fetch',
    ])
      assert.strictEqual(await refused(command), undefined, command)
  })

  it('⛔ rsync -e/--rsh com programa que não é ssh simples; --rsync-path com comando', async () => {
    for (const command of [
      'rsync -e ./wrapper dir host:/tmp/',
      'rsync -avze "sh -c id" dir host:/tmp/',
      'rsync --rsh="ssh; id" dir host:/tmp/',
      'rsync --rsh ./wrapper dir host:/tmp/',
      'rsync -e "ssh -o ProxyCommand=evil" dir host:/tmp/',
      'rsync --rsync-path="sudo rsync" dir host:/tmp/',
      'RSYNC_RSH=./wrapper rsync dir host:/tmp/',
    ])
      assert.ok(await refused(command), command)
  })

  it('⛔ GIT_SSH_COMMAND / GIT_SSH / core.sshCommand com programa que não é ssh simples', async () => {
    for (const command of [
      'GIT_SSH_COMMAND="sh -c id" git fetch',
      'GIT_SSH_COMMAND=./wrapper git fetch',
      'export GIT_SSH_COMMAND="ssh -o ProxyCommand=evil"; git fetch',
      'env GIT_SSH_COMMAND="ssh $X" git fetch',
      'GIT_SSH=./wrapper git fetch',
      'git -c core.sshCommand=./wrapper fetch',
      'git -c core.sshCommand="ssh; id" fetch',
      'git --config-env=core.sshCommand=PROG fetch',
      'git config core.sshCommand ./wrapper',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=x git fetch',
    ])
      assert.ok(await refused(command), command)
  })

  it('o terminalRefusal aplica a trava (rodando o caminho completo)', async () => {
    const allow = [rule('ssh *', 'allow'), rule('git *', 'allow')]
    assert.match((await refusal('ssh -o ProxyCommand="sh -c id" host', allow)) ?? '', /ProxyCommand/)
    assert.strictEqual(await refusal('ssh -p 22 host ls', allow), undefined)
  })
})

describe('terminal — /tmp privado do cerco e recusas com a saída', () => {
  const allow = [rule('tail *', 'allow'), rule('cmd *', 'allow'), rule('cat *', 'allow'), rule('echo *', 'allow')]
  const inSandbox = (command: string, rules = allow) => terminalRefusal(command, '/w', checker(rules), {}, undefined, { privateTmp: true })

  it('⛔ projeto que mora dentro de /tmp: o /tmp não é só do comando, vale a regra', async () => {
    const refusal = await terminalRefusal('echo x > ../fora.txt', '/tmp/proj/root', checker(allow), {}, undefined, { privateTmp: true })
    assert.match(String(refusal), /nenhuma regra de escrita permite/)
  })

  it('no cerco, escrever e ler `/tmp/**` e `/var/tmp/**` passa sem regra', async () => {
    assert.strictEqual(await inSandbox('cmd > /tmp/x.log; tail /tmp/x.log'), undefined)
    assert.strictEqual(await inSandbox('cmd >> /var/tmp/a/x.log 2>&1'), undefined)
    assert.strictEqual(await inSandbox('cat < /tmp/in.txt'), undefined)
  })

  it('⛔ sem cerco segue recusado; e `..` que sai do /tmp, ou outro lugar, também', async () => {
    assert.match((await refusal('cmd > /tmp/x.log', allow)) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await refusal('cat < /tmp/in.txt', allow)) ?? '', /nenhuma regra de leitura permite/)
    assert.match((await inSandbox('cmd > /tmp/../etc/x')) ?? '', /nenhuma regra de escrita/)
    assert.match((await inSandbox('cmd > /tmpx/x')) ?? '', /nenhuma regra de escrita/)
    assert.match((await inSandbox('cmd > /etc/x')) ?? '', /nenhuma regra de escrita/)
  })

  it('read_file de /tmp segue pela regra (a ferramenta de arquivo não ganha o /tmp privado)', () => {
    assert.strictEqual(decide({ category: 'read', value: '/tmp/x.log' }, { project: [] }).allowed, false)
  })

  it('cada recusa por não analisar diz a saída, com o motivo técnico no fim', async () => {
    const cases: Array<[string, RegExp]> = [
      ['PATH=/x ls', /chame pelo caminho: \.\/node_modules\/\.bin\/x.*\(env:PATH\)$/],
      ['$B validate', /escreva o caminho literal \(relativo à pasta\) no lugar de \$VAR.*\(dynamic-command\)$/],
      ['echo x > $LOG', /o destino vem de variável; escreva o caminho literal \(dynamic-redirect\)$/],
      ['python3 - <<EOF\nprint(1)\nEOF', /grave-o num arquivo.*python3 arquivo\.py` \(heredoc-interpreter\)$/],
    ]
    for (const [command, expected] of cases) assert.match((await inSandbox(command)) ?? '', expected, command)
  })

  it('a recusa por regra de terminal diz como pedir a regra; a do sistema, não', async () => {
    assert.match((await inSandbox('ls', [])) ?? '', /nenhuma regra de terminal permite.*save_permission_rules/)
    assert.match((await inSandbox('ls', [rule('ls', 'deny')])) ?? '', /negado pela regra do projeto.*save_permission_rules/)
    assert.doesNotMatch((await inSandbox('rm -rf /')) ?? '', /save_permission_rules/)
  })
})

describe('terminal — $TMPDIR do cerco e variável de laço literal', () => {
  const wr = (pattern: string): IPermissionRule => ({ category: 'write', pattern, decision: 'allow' })
  const base = [
    rule('node *', 'allow'),
    rule('cat *', 'allow'),
    rule('echo *', 'allow'),
    rule('awk *', 'allow'),
    rule('printf *', 'allow'),
    rule('read *', 'allow'),
    rule('bash *', 'allow'),
  ]
  const run = (command: string, rules: IPermissionRule[]) =>
    terminalRefusal(command, '/w', checker([...base, ...rules]), {}, undefined, { variables: { TMPDIR: '/w/.tmp', HOME: '/w/.home' } })

  it('`> $TMPDIR/x`, `${TMPDIR}/x` e `"$TMPDIR/x"` passam com a regra de escrita da pasta tmp', async () => {
    for (const dest of ['$TMPDIR/val.txt', '${TMPDIR}/val.txt', '"$TMPDIR/val.txt"', '$HOME/a.txt']) {
      assert.strictEqual(await run(`node x.mjs > ${dest}`, [wr('.tmp/**'), wr('.home/**')]), undefined, dest)
    }
  })

  it('⛔ sem regra de escrita para a pasta tmp, o caminho resolvido é recusado pela regra normal', async () => {
    assert.match((await run('node x.mjs > $TMPDIR/val.txt', [])) ?? '', /nenhuma regra de escrita permite/)
  })

  it('no cerco, o rascunho (`$TMPDIR`, `$HOME`) passa sem regra; fora dele, não', async () => {
    const inCerco = (command: string) =>
      terminalRefusal(command, '/w', checker(base), {}, undefined, { variables: { TMPDIR: '/w/.tmp', HOME: '/w/.home' }, scratch: ['/w/.tmp', '/w/.home'] })
    assert.strictEqual(await inCerco('node x.mjs > $TMPDIR/val.txt 2>&1'), undefined)
    assert.strictEqual(await inCerco('echo x > .home/a.txt'), undefined)
    assert.match((await inCerco('echo x > .tmpx/a.txt')) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await inCerco('echo x > ../fora.txt')) ?? '', /nenhuma regra de escrita permite/)
  })

  it('⛔ TMPDIR reatribuído no script, outra variável e expansão com operador seguem dinâmicas', async () => {
    const rules = [wr('**')]
    for (const command of [
      'TMPDIR=/etc; echo x > $TMPDIR/y',
      'export TMPDIR=/etc; echo x > $TMPDIR/y',
      'echo x > $TMPDIR/y; TMPDIR=/etc',
      'read TMPDIR; echo x > $TMPDIR/y',
      'echo x > $OUTRA/y',
      'echo x > ${TMPDIR:-/etc}/y',
      'echo x > ${TMPDIR%/*}/y',
    ]) {
      assert.match((await run(command, rules)) ?? '', /dynamic-redirect/, command)
    }
    assert.strictEqual(await run('printf %s $TMPDIR; echo x > $TMPDIR/y', rules), undefined)
  })

  it('sem as variáveis do cerco informadas, `$TMPDIR` segue dinâmico', async () => {
    assert.match((await terminalRefusal('echo x > $TMPDIR/y', '/w', checker([...base, wr('**')]), {})) ?? '', /dynamic-redirect/)
  })

  it('`for f in a.ts b.ts; do cat x > $f; done`: passa se a regra cobre os dois, recusa se cobre só um', async () => {
    assert.strictEqual(await run('for f in a.ts b.ts; do awk 1 $f > /w/.tmp/x && cat /w/.tmp/x > $f; done', [wr('**')]), undefined)
    assert.strictEqual(await run('for f in a.ts b.ts; do cat x > $f; done', [wr('a.ts'), wr('b.ts')]), undefined)
    assert.match((await run('for f in a.ts b.ts; do cat x > $f; done', [wr('a.ts')])) ?? '', /nenhuma regra de escrita permite/)
  })

  it('⛔ laço sobre lista não literal, reatribuído no corpo, ou variável fora do corpo, segue dinâmico', async () => {
    const rules = [wr('**')]
    for (const command of [
      'for f in $(ls); do cat x > $f; done',
      'for f in *.ts; do cat x > $f; done',
      'for f in a.ts $X; do cat x > $f; done',
      'for f in a.ts b.ts; do f=/etc/passwd; cat x > $f; done',
      'for f in a.ts b.ts; do read f; cat x > $f; done',
      'for f in a.ts b.ts; do :; done; cat x > $f',
      'for f; do cat x > $f; done',
    ]) {
      assert.match((await run(command, rules)) ?? '', /dynamic-redirect/, command)
    }
  })
})

describe('a recusa da política diz a saída', () => {
  it('sudo remoto: aponta a regra que o libera; local: nunca', async () => {
    const { policyRefusal } = await import('./Local.Tools')
    assert.match(
      policyRefusal('privilege escalation', "ssh 10.10.0.1 'sudo ls /var/lib'"),
      /^Refused by the gateway tool policy: privilege escalation\. No host remoto.*save_permission_rules/,
    )
    assert.match(policyRefusal('privilege escalation', 'sudo ls'), /Local, isso nunca roda no cerco\.$/)
    assert.strictEqual(policyRefusal('recursive force delete', 'rm -rf x'), 'Refused by the gateway tool policy: recursive force delete.')
  })
})
