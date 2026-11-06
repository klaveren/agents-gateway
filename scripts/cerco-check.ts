import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cercoPlan } from '../src/domain/Cerco.Plan'
import { dataDir, projectWorkspace } from '../src/infra/adapters/support/Subscription.Workspace'
import { networkGate } from '../src/infra/permissions/Network.Gate'
import { projectSandbox } from '../src/infra/sandbox/Project.Sandbox'

/**
 * `tsx scripts/cerco-check.ts [<projeto>]` — diagnóstico do cerco no servidor (rodar com o MESMO ambiente do gateway, p.ex.
 * `CERCO_READ_ALLOWLIST=1`). Monta o plano da pasta do projeto, embrulha cada comando de prova pelo mesmo caminho do
 * `run_bash` (`wrapWith`) e imprime se foi o esperado. Sem projeto, usa o primeiro de `<dados>/projects`. Sai com 1 se algo falhar.
 */
const env = process.env
const flag = env.CERCO_READ_ALLOWLIST === '1'
const projects = join(dataDir(env), 'projects')
const projectId = process.argv[2] ?? (existsSync(projects) ? readdirSync(projects)[0] : undefined)
if (!projectId) {
  console.error(`cerco-check: nenhum projeto em ${projects}; passe o id: tsx scripts/cerco-check.ts <projeto>`)
  process.exit(2)
}

interface IProbe {
  name: string
  command: string
  /** `deny` = tem de FALHAR (o cerco fechou); `allow` = tem de FUNCIONAR. */
  expect: 'allow' | 'deny'
  /** Só vale com a chave ligada (sem ela, o host inteiro segue legível). */
  onlyWithFlag?: boolean
}

const probes: IProbe[] = [
  { name: 'ler /etc/hostname', command: 'cat /etc/hostname', expect: 'deny', onlyWithFlag: true },
  { name: 'ler /etc/shadow', command: 'cat /etc/shadow', expect: 'deny' },
  { name: 'listar /opt', command: 'ls /opt', expect: 'deny', onlyWithFlag: true },
  { name: 'listar /srv', command: 'ls /srv', expect: 'deny', onlyWithFlag: true },
  { name: 'listar /var/log', command: 'ls /var/log', expect: 'deny', onlyWithFlag: true },
  { name: 'listar /home', command: 'ls /home', expect: 'deny', onlyWithFlag: true },
  { name: 'ler a pasta de dados', command: `ls ${dataDir(env)}`, expect: 'deny' },
  { name: 'ler /etc/resolv.conf', command: 'cat /etc/resolv.conf', expect: 'allow' },
  { name: 'ler /etc/passwd', command: 'cat /etc/passwd', expect: 'allow' },
  { name: 'listar /usr/bin', command: 'ls /usr/bin >/dev/null', expect: 'allow' },
  { name: 'git --version', command: 'git --version', expect: 'allow' },
  { name: 'node --version', command: 'node --version', expect: 'allow' },
  { name: 'python3 --version', command: 'python3 --version', expect: 'allow' },
  { name: 'ssh -V', command: 'ssh -V', expect: 'allow' },
  { name: 'curl --version', command: 'curl --version | head -1', expect: 'allow' },
  { name: 'gravar na pasta do projeto', command: 'touch .cerco-check && rm .cerco-check', expect: 'allow' },
]

function exec(line: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', line], { cwd, env: { ...env, HOME: cwd } })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out: out.trim().split('\n').slice(0, 2).join(' | ').slice(0, 160) })
    })
  })
}

async function main(): Promise<void> {
  const sandbox = projectSandbox()
  const status = await sandbox.status()
  console.log(
    `cerco: ${status.available ? 'disponível' : `INDISPONÍVEL (${status.reason})`} [${status.mechanism}] | CERCO_READ_ALLOWLIST=${flag ? '1 (ligada)' : 'desligada'} | projeto=${projectId}`,
  )
  if (!status.available || !sandbox.wrapWith) process.exit(2)
  const root = projectWorkspace(projectId!, env)
  // Como um agente com leitura e escrita livres na pasta do projeto: o que se prova é o que está FORA dela.
  const layers = {
    agent: [
      { category: 'read' as const, pattern: '**', decision: 'allow' as const },
      { category: 'write' as const, pattern: '**', decision: 'allow' as const },
    ],
  }
  const gate = networkGate()
  let failed = 0
  for (const probe of probes) {
    if (probe.onlyWithFlag && !flag) {
      console.log(`  pulado   ${probe.name} (chave desligada)`)
      continue
    }
    const token = gate.register(() => ({ allowed: false, reason: 'diagnóstico' }))
    try {
      const line = await sandbox.wrapWith(probe.command, root, (base) => cercoPlan(layers, { ...base, system: [] }), token, { scratchBase: root })
      const { code, out } = await exec(line, root)
      const ok = probe.expect === 'allow' ? code === 0 : code !== 0
      if (!ok) failed += 1
      console.log(`  ${ok ? 'ok      ' : 'FALHOU  '} ${probe.name} (esperado: ${probe.expect === 'allow' ? 'funcionar' : 'falhar'}; saída ${code}) ${out}`)
    } catch (error: unknown) {
      failed += 1
      console.log(`  FALHOU   ${probe.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      gate.release(token)
      sandbox.done?.()
    }
  }
  console.log(failed ? `\n${failed} prova(s) falharam.` : '\ntodas as provas conforme o esperado.')
  process.exit(failed ? 1 : 0)
}

void main()
