import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { decide, type IPermissionRule } from '@domain/Permission.Policy'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { transportRefusal } from './Bash.Guard'
import { lockRefusal } from './Lock.Guard'
import { looseRemoteHint, readOnlyNote, terminalRefusal } from './Local.Tools'

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
      ['f() { echo x; }; f', /função do shell esconde o que roda.*ferramenta de escrita.*\(function\)$/],
      ['python3 - <<EOF\nprint(1)\nEOF', /grave-o num arquivo em \$TMPDIR.*interpretador que a sua regra libera.*\(heredoc-interpreter\)$/],
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

  it('`cd $TMPDIR && … > x` grava no rascunho; o `cd` com `;`, outra variável ou fora do rascunho segue da raiz', async () => {
    const inCerco = (command: string) =>
      terminalRefusal(command, '/w', checker(base), {}, undefined, { variables: { TMPDIR: '/w/.tmp', HOME: '/w/.home' }, scratch: ['/w/.tmp', '/w/.home'] })
    assert.strictEqual(await inCerco('cd $TMPDIR && echo x > d/a.dump'), undefined)
    assert.strictEqual(await inCerco('cd "${HOME}/sub" && echo x > a.txt'), undefined)
    assert.match((await inCerco('cd $TMPDIR; echo x > a.txt')) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await inCerco('cd $TMPDIR && echo x > ../../fora.txt')) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await inCerco('cd $OUTRA && echo x > a.txt')) ?? '', /nenhuma regra de escrita permite|dynamic/)
    assert.match((await inCerco('cd $TMPDIR/.. && echo x > a.txt')) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await inCerco('TMPDIR=/etc; cd $TMPDIR && echo x > a.txt')) ?? '', /nenhuma regra de escrita permite|dynamic/)
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

  it('`D=$TMPDIR/x; … > $D/y`: a variável da própria linha vale o valor, depois da atribuição', async () => {
    const inCerco = (command: string, rules: IPermissionRule[] = []) =>
      terminalRefusal(command, '/w', checker([...base, ...rules]), {}, undefined, { variables: { TMPDIR: '/w/.tmp', HOME: '/w/.home' }, scratch: ['/w/.tmp', '/w/.home'] })
    assert.strictEqual(await inCerco('D=$TMPDIR/head; echo x > $D/a.txt'), undefined)
    // O `$$` (o PID, só dígitos) fica dentro da pasta: o teste do Zeus em 07/11 era recusado como destino dinâmico.
    assert.strictEqual(await inCerco('f="$TMPDIR/rw-probe-$$"; echo ok > "$f" && cat "$f" && rm "$f"', [rule('cat *', 'allow'), rule('rm *', 'allow')]), undefined)
    assert.strictEqual(await inCerco('echo ok > $TMPDIR/x-$$'), undefined)
    assert.match((await inCerco('echo ok > $TMPDIR/../x-$$')) ?? '', /nenhuma regra de escrita permite/)
    // ⛔ `$RANDOM` não vale dígito: depois do `unset`, é uma variável comum (aqui, o caminho de fora que ela aponta).
    assert.match((await inCerco('unset RANDOM; RANDOM=../x; echo ok > $TMPDIR/$RANDOM')) ?? '', /nenhuma regra de escrita permite "x"/)
    assert.strictEqual(await inCerco('D=$TMPDIR/head\nE=$D/sub\necho x > "$E/a.txt"'), undefined)
    assert.strictEqual(await inCerco('D=out; echo x > $D/a.txt', [wr('out/**')]), undefined)
    assert.match((await inCerco('D=out; echo x > $D/a.txt')) ?? '', /nenhuma regra de escrita permite "out\/a.txt"/)
  })

  it('⛔ a variável da linha segue dinâmica: antes da atribuição, condicional, reatribuída, com espaço, ou no nome do comando', async () => {
    const rules = [wr('**')]
    for (const command of [
      'echo x > $D/a; D=out',
      'true && D=out; echo x > $D/a',
      'if true; then D=out; fi; echo x > $D/a',
      '(D=out); echo x > $D/a',
      'D=out; D=etc; echo x > $D/a',
      'D=out; read D; echo x > $D/a',
      'D="a b"; echo x > $D/a',
      'D=*; echo x > $D/a',
      'D=$(pwd); echo x > $D/a',
    ]) {
      assert.match((await run(command, rules)) ?? '', /dynamic-redirect/, command)
    }
    assert.match((await run('X=rm; $X -r a', [rule('rm *', 'allow')])) ?? '', /não dá para analisar|dynamic-command/)
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
    assert.match(policyRefusal('privilege escalation', 'sudo ls'), /Local, só com uma regra de terminal exata que o cite/)
    assert.strictEqual(policyRefusal('recursive force delete', 'rm -rf x'), 'Refused by the gateway tool policy: recursive force delete.')
  })

  it('várias chamadas de sudo remoto: diz quais ficaram sem regra', async () => {
    const { remoteSudoGap } = await import('./Local.Tools')
    const rules = [rule('ssh * sudo ls *', 'allow')]
    const line = "ssh 10.10.0.1 'sudo ls /var/lib' && ssh 10.10.0.1 'sudo systemctl restart k3s'"
    assert.deepStrictEqual(await remoteSudoGap(line, checker(rules), {}), ['sudo systemctl restart k3s'])
    assert.strictEqual(await remoteSudoGap("ssh 10.10.0.1 'sudo ls /var/lib'", checker(rules), {}), undefined)
    assert.deepStrictEqual(await remoteSudoGap('sudo ls', checker(rules), {}), [])
  })
})

describe('embutidos inofensivos do shell', () => {
  it('`echo ---`, `cd`, `pwd` passam sem regra; a negação explícita e o redirecionamento seguem valendo', async () => {
    const allowGit = [rule('git *', 'allow')]
    const refuse = (command: string, rules: IPermissionRule[]) => terminalRefusal(command, '/w', checker(rules), {})
    assert.strictEqual(await refuse('cd repo && pwd; echo ---; git log -1', allowGit), undefined)
    assert.match((await refuse('echo x > fora.txt', allowGit)) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await refuse('echo ---', [...allowGit, rule('echo *', 'deny')])) ?? '', /negado/)
    assert.match((await refuse('ls', allowGit)) ?? '', /nenhuma regra de terminal permite/)
  })
})

describe('terminal — o `cd` que abre a linha', () => {
  const rules = [rule('node repositories/x/tools/check-*', 'allow'), rule('node repositories/x/tools/evil*', 'deny'), rule('node tools/evil2*', 'deny')]

  it('⚖️ a regra escrita da pasta do projeto vale depois de `cd repositories/x &&`', async () => {
    assert.strictEqual(await refusal('cd repositories/x && node tools/check-a.mjs --help', rules), undefined)
    assert.strictEqual(await refusal('cd repositories/x && node ./tools/check-a.mjs', rules), undefined)
    assert.strictEqual(await refusal('node repositories/x/tools/check-a.mjs', rules), undefined)
  })

  it('⛔ negar, em qualquer das duas formas, vence', async () => {
    assert.ok(await refusal('cd repositories/x && node tools/evil.mjs', [...rules, rule('node *', 'allow')]))
    assert.ok(await refusal('cd repositories/x && node tools/evil2.mjs', [...rules, rule('node *', 'allow')]))
  })

  it('o redirecionamento depois do `cd` é conferido na pasta nova', async () => {
    const write = (pattern: string): IPermissionRule => ({ category: 'write', pattern, decision: 'allow' })
    assert.strictEqual(await refusal('cd repositories/x && echo a > out/a.txt', [write('repositories/x/out/**')]), undefined)
    assert.ok(await refusal('cd repositories/x && echo a > out/a.txt', [write('out/**')]))
  })

  it('⛔ só com `&&`, pasta literal, sem outra troca de pasta, e sem sair da raiz', async () => {
    for (const command of [
      'cd repositories/x; node tools/check-a.mjs',
      'cd repositories/x || true && node tools/check-a.mjs',
      'cd "$D" && node tools/check-a.mjs',
      'cd repositories/x && cd .. && node tools/check-a.mjs',
      'cd ../x && node tools/check-a.mjs',
      '(cd repositories/x) && node tools/check-a.mjs',
    ]) {
      assert.ok(await refusal(command, rules), command)
    }
  })
})

describe('terminal — "Read-only file system" no cerco', () => {
  it('explica que é falta de regra de escrita, não o disco', () => {
    const note = readOnlyNote('/bin/bash: line 127: Page.ReservedSlugs.test.ts: Read-only file system')
    assert.match(note, /não tem regra de escrita/)
    assert.match(note, /o disco do servidor não está somente leitura/)
    assert.match(note, /ferramenta de escrita \(Write\)/)
    assert.match(readOnlyNote("touch: cannot touch 'zz': EROFS"), /regra de escrita/)
    assert.strictEqual(readOnlyNote('ok'), '')
  })

  it('⛔ conversa em worktree e o caminho é do principal: a nota é a da pasta de trabalho, não a de pedir regra', () => {
    const place = { dir: '/p/repositories/_wt/x', worktree: 'x', repositoryDir: '/p/repositories/app' }
    const note = readOnlyNote('mkdir: /p/repositories/app/node_modules/.vite-temp: Read-only file system', 'npm test', place)
    assert.match(note, /só leitura nesta conversa/)
    assert.match(note, /`\/p\/repositories\/_wt\/x\/node_modules\/\.vite-temp`/)
    assert.doesNotMatch(note, /peça a regra/)
    assert.match(readOnlyNote('/p/repositories/_wt/x/a: Read-only file system', 'npm test', place), /não tem regra de escrita/)
  })
})

describe('terminal — a pasta privada do agente', () => {
  const run = (command: string, write: boolean) =>
    terminalRefusal(command, '/w', checker([rule('echo *', 'allow'), rule('cat *', 'allow')]), {}, undefined, { own: { dirs: ['/w/agents/rui'], write } })

  it('grava e lê na própria pasta pelo terminal quando tem a escrita de arquivos', async () => {
    assert.strictEqual(await run('echo probe > agents/rui/zz.txt && cat < agents/rui/zz.txt', true), undefined)
    assert.strictEqual(await run('cd agents && echo probe > rui/zz.txt', true), undefined)
  })

  it('⛔ só leitura sem a escrita; fora da pasta (ou saindo dela com ..), a regra decide', async () => {
    assert.strictEqual(await run('cat < agents/rui/zz.txt', false), undefined)
    assert.match((await run('echo probe > agents/rui/zz.txt', false)) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await run('echo probe > agents/outro/zz.txt', true)) ?? '', /nenhuma regra de escrita permite/)
    assert.match((await run('echo probe > agents/rui/../outro/zz.txt', true)) ?? '', /nenhuma regra de escrita permite/)
  })
})

describe('terminal — `IFS=` do `read` e `bash --version`', () => {
  const rules = [rule('grep *', 'allow'), rule('printf *', 'allow'), rule('read *', 'allow'), rule('bash *', 'allow'), rule('cut *', 'allow'), rule('echo *', 'allow')]

  it('passam: o IFS vale só para o read; o --version não lê o stdin', async () => {
    assert.strictEqual(await refusal('grep -n x a.sh | while IFS= read -r l; do printf \'%s\\n\' "$l" | cut -c1-60; done', rules), undefined)
    assert.strictEqual(await refusal('bash --version | head -1', [...rules, rule('head *', 'allow')]), undefined)
  })

  it('⛔ o IFS fora do read, e o bash sem script, seguem recusados', async () => {
    assert.match((await refusal('IFS=/; echo $PATH', rules)) ?? '', /env:IFS/)
    assert.match((await refusal('IFS=x echo a', rules)) ?? '', /env:IFS/)
    assert.match((await refusal('echo ls | bash', rules)) ?? '', /shell-stdin/)
    assert.match((await refusal('echo ls | bash -x', rules)) ?? '', /shell-stdin/)
  })
})

describe('terminal — regras contra o comando remoto do ssh, palavra por palavra', () => {
  const sudo = [rule('ssh * sudo *', 'allow')]

  it('✅ `ssh * sudo *` cobre o comando remoto entre aspas (antes a aspa grudava no sudo e nada casava), com `>` no argumento', async () => {
    for (const command of [
      `ssh isrv2 "sudo grub-set-default 'gnulinux-advanced-x>gnulinux-6.17-x'"`,
      `ssh isrv2 'sudo systemctl restart k3s'`,
      `ssh -o BatchMode=yes ubuntu@isrv2 "sudo cat /etc/default/grub"`,
      `ssh isrv2 "sudo sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=saved/' /etc/default/grub"`,
    ]) {
      assert.strictEqual(await refusal(command, sudo), undefined, command)
    }
  })

  it('⚖️ quem liberou com sudo liberou o mesmo sem sudo: o `tail` do pipe e o `cd` passam', async () => {
    assert.strictEqual(await refusal(`ssh isrv2 "sudo update-grub 2>&1 | tail -5"`, sudo), undefined)
    assert.strictEqual(await refusal(`ssh isrv2 "cd /etc && sudo ls"`, sudo), undefined)
  })

  it('a regra estreita segue estreita: `ssh * sudo systemctl *` não cobre outro comando na mesma linha', async () => {
    const narrow = [rule('ssh * sudo systemctl *', 'allow')]
    assert.strictEqual(await refusal(`ssh h "sudo systemctl status k3s"`, narrow), undefined)
    assert.ok(await refusal(`ssh h "sudo systemctl status k3s; rm -rf ~/x"`, narrow))
    assert.ok(await refusal(`ssh h "sudo journalctl -u k3s"`, narrow))
  })

  it('⛔ a negação da pessoa num comando remoto vence, mesmo com `ssh *` liberado; a do sudo não fecha o comando sem sudo', async () => {
    const rules = [rule('ssh *', 'allow'), rule('ssh * sudo rm *', 'deny')]
    assert.ok(await refusal(`ssh h "ls; sudo rm -f /x"`, rules))
    assert.strictEqual(await refusal(`ssh h "rm -f /tmp/x"`, rules), undefined)
  })

  it('⛔ linha remota montada pelo shell local (`$(…)`) não ganha a leitura por palavras', async () => {
    assert.ok(await refusal('ssh h "sudo $(cat cmd)"', sudo))
  })
})

describe('recusa do sudo remoto — o comando remoto solto', () => {
  it("⚠️ `ssh h sudo x 'a>b'` (sem aspas em volta): a recusa explica que o shell de lá relê o `>` e mostra a forma com aspas", async () => {
    const loose = await analyzeShell("ssh 10.10.0.2 sudo grub-set-default 'gnulinux-advanced-x>gnulinux-6.17-x'")
    assert.match(looseRemoteHint(loose.commands), /sem aspas em volta[\s\S]*entre aspas duplas/)
    const quoted = await analyzeShell(`ssh 10.10.0.2 "sudo grub-set-default 'gnulinux-advanced-x>gnulinux-6.17-x'"`)
    assert.strictEqual(looseRemoteHint(quoted.commands), '')
    assert.strictEqual(looseRemoteHint((await analyzeShell('ssh h sudo update-grub')).commands), '', 'palavras simples soltas passam como estão')
  })
})

describe('regra exata libera — as travas cedem à regra do admin que casa e cita', () => {
  const stdin = 'ssh -o BatchMode=yes -o ConnectTimeout=7 -o ServerAliveInterval=30 10.10.0.4 "bash -s" < rel3.sh > out'
  const loose = 'ssh -o BatchMode=yes 10.10.0.4 bash -s < arq'
  const exact = rule('ssh * 10.10.0.4 bash -s', 'allow')
  const files = [{ category: 'read', pattern: '**', decision: 'allow' } as IPermissionRule, { category: 'write', pattern: '**', decision: 'allow' } as IPermissionRule]

  it('✅ o caso de 26/11: `ssh … "bash -s" < script` passa com `ssh * 10.10.0.4 bash -s`, nas duas formas, e nas duas travas', async () => {
    for (const command of [stdin, loose]) {
      assert.strictEqual(await lockRefusal(command, checker([exact]), {}), undefined, command)
      assert.strictEqual(await refusal(command, [exact, ...files]), undefined, command)
    }
    assert.strictEqual(await lockRefusal(stdin, checker([rule('ssh * 10.10.0.4 "bash -s"', 'allow')]), {}), undefined, 'aspas na regra não contam')
  })

  it('⛔ sem a regra, recusado: a mensagem diz o motivo real e a regra exata que libera', async () => {
    const message = (await lockRefusal(stdin, checker([]), {})) ?? ''
    assert.match(message, /script por stdin no host remoto \(o gateway não vê o conteúdo\): só passa com regra exata, ex\. `ssh \* 10\.10\.0\.4 bash -s`/)
    assert.doesNotMatch(message, /sem regra/)
    assert.ok(await refusal(stdin, files))
  })

  it('⛔ curinga na parte remota não libera a linha opaca, e a recusa diz por que a regra não cobre', async () => {
    for (const pattern of ['ssh * 10.10.0.4 *', 'ssh *', '*', 'ssh * 10.10.0.4 bash *', 'ssh * 10.10.0.4 bash -s*']) {
      const message = (await lockRefusal(loose, checker([rule(pattern, 'allow')]), {})) ?? ''
      assert.match(message, /privilege escalation/, pattern)
      if (pattern.startsWith('ssh')) assert.match(message, /não cobre: com a linha opaca, a parte remota da regra tem de ser IGUAL/, pattern)
    }
    assert.ok(await lockRefusal('ssh 10.10.0.5 bash -s < arq', checker([exact]), {}), 'outro host')
    assert.ok(await lockRefusal('ssh 10.10.0.4 bash -s -x < arq', checker([exact]), {}), 'outra linha')
    assert.ok(await lockRefusal('x=bash; ssh 10.10.0.4 "$x -s" < arq', checker([exact, rule('ssh * 10.10.0.4 $x -s', 'allow')]), {}), 'montada pelo shell local')
  })

  it('⛔ deny vence a regra exata', async () => {
    const rules = [exact, rule('ssh * 10.10.0.4 bash *', 'deny'), ...files]
    assert.ok(await refusal(loose, rules))
    const zeus = [rule('ssh * sudo *', 'allow'), rule('ssh * sudo k3s kubectl * get secret*', 'deny')]
    assert.strictEqual(await lockRefusal('ssh 10.10.0.1 "sudo k3s kubectl get secret x"', checker(zeus), {}), undefined, 'a trava cede ao allow...')
    assert.ok(await refusal('ssh 10.10.0.1 "sudo k3s kubectl get secret x"', zeus), '...e o terminal aplica o deny')
  })

  it('✅ trava de texto: `rm -rf /x` passa com a regra `rm -rf /x`; ⛔ não com `rm *`, `*` nem `bash *`', async () => {
    assert.strictEqual(await lockRefusal('rm -rf /x', checker([rule('rm -rf /x', 'allow')]), {}), undefined)
    assert.strictEqual(await lockRefusal('rm -rf build/out', checker([rule('rm -rf build/*', 'allow')]), {}), undefined)
    assert.strictEqual(await lockRefusal('mkfs.ext4 /dev/sdb1', checker([rule('mkfs.ext4 /dev/sdb1', 'allow')]), {}), undefined)
    for (const pattern of ['rm *', '*', 'rm -*']) {
      const message = (await lockRefusal('rm -rf /x', checker([rule(pattern, 'allow')]), {})) ?? ''
      assert.match(message, /^recursive force delete em `rm -rf \/x` — .*casa, mas não cita a parte travada.*ex\. `rm -rf \/x`/, pattern)
    }
    for (const pattern of ['bash *', 'rm -r *']) assert.ok(await lockRefusal('rm -rf /x', checker([rule(pattern, 'allow')]), {}), pattern)
    assert.match((await lockRefusal('rm -rf /x', checker([]), {})) ?? '', /só passa com regra exata que a cite, ex\. `rm -rf \/x`/)
    assert.ok(await lockRefusal('rm -rf /x; rm -rf /y', checker([rule('rm -rf /x', 'allow')]), {}), 'cada trecho travado precisa da sua regra')
    assert.match((await lockRefusal('rm -rf /x', checker([rule('rm -rf /x', 'allow'), rule('rm -rf *', 'deny')]), {})) ?? '', /recursive force delete/, 'deny vence')
  })

  it('✅ remoto: `ssh h "rm -rf /x"` passa com a regra que cita o comando remoto; o sudo LOCAL, com a regra que o cita', async () => {
    assert.strictEqual(await lockRefusal('ssh h "rm -rf /x"', checker([rule('ssh * h rm -rf /x', 'allow')]), {}), undefined)
    assert.ok(await lockRefusal('ssh h "rm -rf /x; rm -rf /"', checker([rule('ssh * h rm -rf /x', 'allow')]), {}))
    assert.strictEqual(await lockRefusal('sudo systemctl restart nginx', checker([rule('sudo systemctl restart nginx', 'allow')]), {}), undefined)
    assert.strictEqual(await lockRefusal('sudo rm -rf /x', checker([rule('sudo rm -rf /x', 'allow')]), {}), undefined)
    assert.strictEqual(await refusal('sudo rm -rf /x', [rule('sudo rm -rf /x', 'allow')]), undefined, 'o de dentro do sudo fica com a regra do de fora')
    assert.ok(await refusal('sudo rm -rf /x', [rule('sudo rm -rf /x', 'allow'), rule('rm *', 'deny')]), 'a negação do de dentro vence')
    assert.ok(await lockRefusal('sudo rm -rf /', checker([rule('sudo *', 'allow')]), {}), '`sudo *` não cita o rm -rf')
    for (const pattern of ['*', '* id']) assert.match((await lockRefusal('sudo id', checker([rule(pattern, 'allow')]), {})) ?? '', /não cita `sudo`/, pattern)
    assert.strictEqual(
      await lockRefusal('sudo id', checker([rule('sudo id', 'allow')]), {}, { localPrivilege: false }),
      'privilege escalation',
      'agente de máquina: o cartão da pessoa',
    )
  })
})
