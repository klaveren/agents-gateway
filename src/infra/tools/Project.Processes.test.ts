import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { eligibleProcesses, type IProcessInfo, processesTool, withDescendants } from './Project.Processes'

const ROOT = '/dados/projects/logiccus'
const p = (pid: number, ppid: number, command: string, cwd: string): IProcessInfo => ({ pid, ppid, command, cwd })

// O gateway (100, pai 1) com o executor do modelo (110) e um comando cercado (120 → 121 → 122).
const TREE = [
  p(100, 1, 'node gateway', `${ROOT}/repositories/logiccus`),
  p(110, 100, 'node claude-cli', `${ROOT}/repositories/logiccus`),
  p(120, 110, '/usr/bin/sandbox-exec -p (version 1) bash -c npm run dev', `${ROOT}/repositories/logiccus`),
  p(121, 120, 'bash -c npm run dev', `${ROOT}/repositories/logiccus`),
  p(122, 121, 'node vite', `${ROOT}/repositories/logiccus/web`),
  // O `start.sh` que ficou para trás (órfão), com os filhos.
  p(200, 1, '/bin/bash ./start.sh', `${ROOT}/repositories/logiccus`),
  p(201, 200, 'node pnpm --filter agents-api run dev', `${ROOT}/repositories/logiccus`),
  p(202, 201, 'node nodemon', `${ROOT}/repositories/logiccus/apis/agents`),
  // A IDE e o terminal da pessoa, abertos na pasta do projeto.
  p(300, 1, '/Applications/IDE.app/Contents/MacOS/IDE', '/'),
  p(301, 300, 'IDE Helper (Plugin)', `${ROOT}/repositories/logiccus`),
  p(400, 1, '/System/Applications/Utilities/Terminal.app', '/'),
  p(401, 400, '-zsh', `${ROOT}/repositories/logiccus`),
  // Órfão de outro projeto.
  p(500, 1, '/bin/bash ./start.sh', '/dados/projects/outro'),
]

describe('eligibleProcesses — o que o agente pode ver e parar', () => {
  it('⛔ só os do projeto que saíram de comando de agente: o cercado e o órfão; nunca o gateway, o executor, a IDE ou o terminal', () => {
    const pids = eligibleProcesses(TREE, ROOT, 100).map((info) => info.pid)
    assert.deepEqual(pids, [120, 121, 122, 200, 201, 202])
  })

  it('⛔ o gateway e quem o iniciou ficam de fora mesmo quando a cadeia não tem cerco', () => {
    const tree = [p(10, 1, 'launchd-agent', ROOT), p(100, 10, 'node gateway', ROOT), p(150, 100, 'node filho direto', ROOT)]
    assert.deepEqual(eligibleProcesses(tree, ROOT, 100), [])
  })

  it('🖥️ agente de máquina: qualquer processo do usuário (a IDE, o terminal, outro projeto); nunca o gateway nem o executor', () => {
    const pids = eligibleProcesses(TREE, ROOT, 100, true).map((info) => info.pid)
    assert.deepEqual(pids, [120, 121, 122, 200, 201, 202, 300, 301, 400, 401, 500])
  })

  it('withDescendants: o escolhido leva junto os filhos do projeto', () => {
    const eligible = eligibleProcesses(TREE, ROOT, 100)
    const picked = withDescendants(
      eligible.filter((info) => info.pid === 200),
      eligible,
    )
    assert.deepEqual(
      picked.map((info) => info.pid),
      [200, 201, 202],
    )
  })
})

describe('processes — a ferramenta', () => {
  const context = { projectId: 'logiccus', sessionId: 's' } as never
  const masked = (text: string) => text.replace('segredo', '****')

  it('lista os do projeto, avisa os de fora e mascara a saída', async () => {
    const tool = processesTool(
      () => ROOT,
      masked,
      async () => [...TREE, p(203, 200, 'node api --token segredo', ROOT)].map((info) => (info.pid === 100 ? { ...info, pid: process.pid } : info)),
    )
    const result = await tool.execute({ match: 'node', pids: [202, 203, 301] }, context)
    assert.equal(result.status, 'success')
    assert.match(result.result, /^202 · pai 201 · repositories\/logiccus\/apis\/agents · node nodemon/m)
    assert.match(result.result, /203 .*--token \*\*\*\*/)
    assert.match(result.result, /não mexo: 301/)
  })

  it('⛔ o token de rede na linha de comando de um processo sai mascarado', async () => {
    const token = 'tok-de-rede-123456'
    const tool = processesTool(
      () => ROOT,
      (text) => text.split(token).join('[segredo:token de rede]'),
      async () =>
        [p(210, 200, `socat TCP-LISTEN:1 PROXY:x,proxyauth=${token}:x`, ROOT)]
          .concat(p(100, 1, 'node gateway', ROOT))
          .map((info) => (info.pid === 100 ? { ...info, pid: process.pid } : info)),
    )
    const result = await tool.execute({}, context)
    assert.ok(!result.result.includes(token))
    assert.match(result.result, /proxyauth=\[segredo:token de rede\]/)
  })

  it('para sem dizer quais: recusa; sem pasta de projeto: recusa', async () => {
    assert.match(
      (
        await processesTool(
          () => ROOT,
          masked,
          async () => TREE,
        ).execute({ stop: true }, context)
      ).result,
      /match .* ou pids/,
    )
    assert.match(
      (
        await processesTool(
          () => undefined,
          masked,
          async () => TREE,
        ).execute({}, context)
      ).result,
      /não tem pasta de projeto/,
    )
  })

  it('para de verdade o processo do projeto e os filhos', async () => {
    const child = spawn('sleep', ['30'], { detached: true })
    const orphan = p(child.pid!, 1, 'sleep 30', ROOT)
    const tool = processesTool(
      () => ROOT,
      masked,
      async () => [orphan],
    )
    const result = await tool.execute({ pids: [child.pid], stop: true }, context)
    assert.equal(result.status, 'success', result.result)
    assert.match(result.result, /SIGTERM para 1 processo\(s\) do projeto; 1 saíram/)
  })
})
