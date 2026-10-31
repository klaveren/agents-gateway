import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { decide, IPermissionRule } from '@domain/Permission.Policy'
import { IPermissionChecker } from '@application/Permissions.Service'
import { IProjectSandbox } from '@infra/sandbox/Project.Sandbox'
import { BackgroundProcesses, clipOutput, startCommand } from './Background.Processes'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SecretMasker } from '@infra/secrets/Secret.Masker'
import { randomBytes } from 'node:crypto'
import { makeLocalTools } from './Local.Tools'

const root = mkdtempSync(join(tmpdir(), 'gw-bg-'))
after(() => rmSync(root, { recursive: true, force: true }))
const alive = (marker: string) => {
  try {
    return execFileSync('pgrep', ['-f', marker]).toString().trim().length > 0
  } catch {
    return false
  }
}
/** Espera a condição valer (até 10 s): um prazo fixo curto falhava com a suíte inteira rodando em paralelo. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('Background.Processes (o terminal longo)', () => {
  it('a saída longa mostra o começo e o FIM (onde está o erro), e diz onde ler o resto', () => {
    const output = `${'a'.repeat(1000)}MEIO${'b'.repeat(1000)}ERRO NO FIM`
    const clipped = clipOutput(output, 500, 'bash_logs id x')
    assert.ok(clipped.startsWith('a'.repeat(100)))
    assert.ok(clipped.endsWith('ERRO NO FIM'))
    assert.match(clipped, /caracteres omitidos; bash_logs id x/)
    assert.ok(!clipped.includes('MEIO'))
  })

  it('⛔ tempo estourado mata o GRUPO: o neto (um sleep) não sobra', async () => {
    const marker = `sleep 77${process.pid % 10}`
    const result = await startCommand(`(${marker}) & echo comecou; wait`, { cwd: root, env: { PATH: process.env.PATH! }, shell: '/bin/bash', timeoutMs: 400 }).done
    assert.strictEqual(result.timedOut, true)
    assert.match(result.output, /comecou/)
    await until(() => !alive(marker))
    assert.strictEqual(alive(marker), false)
  })

  it('a saída inteira vai para o log, na ordem, stdout e stderr juntos', async () => {
    const logFile = join(root, 'logs', 'x.log')
    const result = await startCommand('echo um; echo dois >&2; echo tres', { cwd: root, env: { PATH: process.env.PATH! }, shell: '/bin/bash', timeoutMs: 5000, logFile }).done
    assert.deepStrictEqual([result.code, result.timedOut], [0, false])
    assert.strictEqual(readFileSync(logFile, 'utf8'), 'um\ndois\ntres\n')
  })
})

describe('o terminal com o executor novo (spawn)', () => {
  const rules: IPermissionRule[] = [{ category: 'terminal', pattern: '*', decision: 'allow' }]
  const checker: IPermissionChecker = { check: (_asker, subject) => decide(subject, { agent: rules }), layers: () => ({ agent: rules, system: [] }) }
  // Sem cerco de verdade: a linha sai como veio (o cerco tem os testes dele).
  const sandbox: IProjectSandbox = { status: async () => ({ available: true, mechanism: 'seatbelt' }), wrap: async (command) => command, wrapWith: async (command) => command }
  const processes = new BackgroundProcesses()
  after(() => processes.stopAll())
  const tools = (agentTerminal?: { timeoutSeconds?: number; maxOutputChars?: number }) =>
    makeLocalTools({ policy: { timeoutMs: 2000, maxOutputChars: 300, cwd: root }, sandbox, permissions: checker, processes, agentTerminal: () => agentTerminal })
  const find = (list: ReturnType<typeof makeLocalTools>, name: string) => list.find((tool) => tool.name === name)!
  const context = { sessionId: 's1', agentId: 'dev' }

  it('saída longa: o fim aparece e o log inteiro é lido com bash_logs', async () => {
    const list = tools()
    const outcome = await find(list, 'run_bash').execute({ command: 'for i in $(seq 1 400); do echo linha-$i; done; echo FALHOU-NO-FIM' }, context)
    assert.match(outcome.result, /FALHOU-NO-FIM\n?$/)
    const id = /bash_logs id (\w+)/.exec(outcome.result)?.[1]
    assert.ok(id)
    const logs = await find(list, 'bash_logs').execute({ id, grep: 'linha-7' }, context)
    assert.match(logs.result, /linha-7\n/)
    assert.match((await find(list, 'bash_logs').execute({ id }, { sessionId: 'outra' })).result, /Não há processo/)
  })

  it('o tempo do agente vale, e o modelo pode pedir mais só até ele', async () => {
    assert.match((await find(tools(), 'run_bash').execute({ command: 'sleep 3; echo fim' }, context)).result, /Tempo esgotado \(2s\)/)
    assert.match((await find(tools({ timeoutSeconds: 5 }), 'run_bash').execute({ command: 'sleep 3; echo fim' }, context)).result, /fim/)
    assert.match((await find(tools({ timeoutSeconds: 5 }), 'run_bash').execute({ command: 'sleep 3; echo fim', timeoutSeconds: 1 }, context)).result, /Tempo esgotado \(1s\)/)
  })

  it('segundo plano: inicia, lê o log, para; teto por conversa; código de saída diferente de 0 é erro', async () => {
    const list = tools()
    const started = await find(list, 'bash_start').execute({ command: 'while true; do echo vivo; sleep 0.1; done', name: 'watch' }, context)
    const id = String(/id (\w+)/.exec(started.result)?.[1])
    const read = async () => (await find(list, 'bash_logs').execute({ id, tail: 2 }, context)).result
    let logs = await read()
    for (const deadline = Date.now() + 10_000; !/vivo/.test(logs) && Date.now() < deadline; logs = await read()) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.match(logs, /running[\s\S]*vivo/)
    assert.match((await find(list, 'bash_list').execute({}, context)).result, new RegExp(`${id} · segundo plano · running`))
    assert.match((await find(list, 'bash_stop').execute({ id }, context)).result, /stopped/)
    for (let index = 0; index < 5; index++) await find(list, 'bash_start').execute({ command: 'sleep 30' }, context)
    assert.match((await find(list, 'bash_start').execute({ command: 'sleep 30' }, context)).result, /Já há 5 processos/)
    assert.strictEqual((await find(list, 'run_bash').execute({ command: 'exit 3' }, context)).status, 'error')
  })

  it('⛔ máscara: a variável da conta sai mascarada, o kubectl que despeja Secret não roda, o literal gera aviso', async () => {
    const masker = new SecretMasker(new SecretBox(randomBytes(32)), ':memory:', () => [{ value: 'chave-do-provider-XYZ1', label: 'chave openai' }])
    const list = makeLocalTools({
      policy: { timeoutMs: 5000, maxOutputChars: 2000, cwd: root },
      sandbox,
      permissions: {
        check: (_asker, subject) => decide(subject, { agent: [...rules, { category: 'account', pattern: 'gitlab', decision: 'allow' }] }),
        layers: () => ({ agent: rules, system: [] }),
      },
      processes,
      mask: masker,
      accounts: { commandEnv: async () => ({ env: { GITLAB_TOKEN: 'glpat-valor-da-conta-1234' }, problems: [] }) },
    })
    const ctx = { sessionId: 'mask-1', agentId: 'dev', conversationProjectId: 'p1' }
    const out = await find(list, 'run_bash').execute({ command: 'printenv GITLAB_TOKEN; echo DB_PASSWORD=Zx81kLmnQ2pRt5vWy7' }, ctx)
    assert.match(out.result, /\[segredo:GITLAB_TOKEN\]\nDB_PASSWORD=\[segredo:DB_PASSWORD\]/)
    assert.ok(!out.result.includes('glpat-valor'))
    assert.match((await find(list, 'run_bash').execute({ command: 'kubectl get secret app -o json' }, ctx)).result, /describe secret/)
    const literal = await find(list, 'run_bash').execute({ command: 'echo chave-do-provider-XYZ1' }, ctx)
    assert.match(literal.result, /segredo escrito por extenso \(chave openai\)[\s\S]*\[segredo:chave openai\]/)
  })
})
