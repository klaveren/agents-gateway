import assert from 'node:assert'
import { describe, it } from 'node:test'
import { terminalRuleWarning } from './TerminalRule.Policy'

describe('terminalRuleWarning — a regra de terminal que nunca libera o que parece querer', () => {
  it('⚠️ curinga na parte remota de um shell que lê o stdin: avisa e mostra a regra exata', () => {
    for (const pattern of ['ssh * 10.10.0.4 bash *', 'ssh * 10.10.0.4 bash -s*', 'ssh 10.10.0.4 sh -?']) {
      assert.match(terminalRuleWarning(pattern) ?? '', /nunca libera script por stdin/, pattern)
    }
    assert.match(terminalRuleWarning('ssh * 10.10.0.4 bash *') ?? '', /ex\. `ssh \* 10\.10\.0\.4 bash -s`/)
    assert.match(terminalRuleWarning('ssh * h "$(cat cmd)"') ?? '', /shell local monta/)
  })

  it('a regra exata, o `bash -c`, o ssh sem shell e o que não é ssh: sem aviso', () => {
    for (const pattern of ['ssh * 10.10.0.4 bash -s', 'ssh * 10.10.0.4 "bash -s"', 'ssh * h bash -c *', 'ssh * sudo k3s kubectl *', 'ssh * 10.10.0.4 *', 'bash *', 'rm -rf /x'])
      assert.strictEqual(terminalRuleWarning(pattern), undefined, pattern)
  })
})
