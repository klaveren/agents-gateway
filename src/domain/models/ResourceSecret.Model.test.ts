import assert from 'node:assert'
import { describe, it } from 'node:test'
import { effectiveSources, printsSecret, secretNameIssue } from './ResourceSecret.Model'

describe('ResourceSecret.Model', () => {
  it('nome: maiúsculas, números e _; os do gateway e do cerco não', () => {
    assert.strictEqual(secretNameIssue('GITLAB_TOKEN'), undefined)
    assert.ok(secretNameIssue('gitlab_token'))
    for (const name of ['HOME', 'PATH', 'GATEWAY_X', 'LD_PRELOAD', 'HTTPS_PROXY']) assert.ok(secretNameIssue(name), name)
  })

  it('⚖️ precedência: command > skill > agente; entre iguais, o carregado por último', () => {
    const sources = effectiveSources(
      [
        { name: 'TOKEN', scope: 'agent', scopeId: 'theo' },
        { name: 'SO_AGENTE', scope: 'agent', scopeId: 'theo' },
      ],
      [
        [{ name: 'TOKEN', scope: 'command', scopeId: 'deploy' }],
        [{ name: 'TOKEN', scope: 'skill', scopeId: 'gitlab' }],
        [{ name: 'API', scope: 'skill', scopeId: 'a' }],
        [{ name: 'API', scope: 'skill', scopeId: 'b' }],
      ],
    )
    assert.deepStrictEqual(
      sources.map((source) => `${source.name}=${source.scope}:${source.scopeId}`),
      ['API=skill:b', 'SO_AGENTE=agent:theo', 'TOKEN=command:deploy'],
    )
  })

  it('⛔ o comando que só mostra a variável é recusado; o que a USA passa', () => {
    const names = ['GITLAB_TOKEN']
    for (const command of [
      'echo $GITLAB_TOKEN',
      'echo "token: ${GITLAB_TOKEN}"',
      'printf "%s" "$GITLAB_TOKEN"',
      'printenv GITLAB_TOKEN',
      'printenv',
      'env',
      'env | grep TOKEN',
      'set',
      'declare -p',
      'export -p',
      'cat /proc/self/environ',
      'ls && echo $GITLAB_TOKEN',
      'cat <<< $GITLAB_TOKEN',
    ])
      assert.ok(printsSecret(command, names), command)
    for (const command of [
      'curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" https://gitlab.com/api/v4/user',
      'git push https://oauth2:$GITLAB_TOKEN@gitlab.com/x/y.git',
      'echo pronto',
      'env FOO=1 node script.js',
      'echo $OUTRA',
    ])
      assert.strictEqual(printsSecret(command, names), undefined, command)
    for (const command of ['env', 'printenv', 'cat /proc/self/environ']) assert.strictEqual(printsSecret(command, []), undefined, `${command} sem variável valendo`)
  })
})
