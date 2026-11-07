import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const SCRIPTS = `${process.cwd()}/infra/debian/`

describe('infra/debian — o laço do dreno do deploy', () => {
  it('a sintaxe do setup.sh e do drain.sh é válida', () => {
    for (const file of ['setup.sh', 'drain.sh', 'deploy.sh']) {
      const run = spawnSync('bash', ['-n', `${SCRIPTS}${file}`], { encoding: 'utf8' })
      assert.strictEqual(run.status, 0, `${file}: ${run.stderr}`)
    }
  })

  it('⛔ espera sem teto, e com teto vencido NÃO reinicia (desliga o dreno e diz quantos turnos sobraram)', () => {
    const run = spawnSync('bash', [`${SCRIPTS}drain.test.sh`], { encoding: 'utf8' })
    assert.strictEqual(run.status, 0, run.stdout + run.stderr)
    assert.ok(!run.stdout.includes('FAIL'), run.stdout)
  })
})
