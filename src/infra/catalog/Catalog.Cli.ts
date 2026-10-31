import type { ICatalogManifest, TCatalogFiles } from '@domain/Catalog.Files'
import { readCatalogDirectory, writeCatalogDirectory } from './Catalog.Directory'

/**
 * A CLI DO CATÁLOGO (`pnpm catalog …`, por `scripts/catalog.ts`), sobre a API:
 * - `export <pasta>`: pede o pacote (`GET /v1/catalog/export?format=json`) e o escreve numa pasta — é por ela que o
 *   catálogo vai para o git;
 * - `plan <pasta>`: lê a pasta e mostra o plano (`POST /v1/catalog/import/plan`), sem gravar nada;
 * - `apply <pasta>`: planeja e aplica com o `planHash` desse plano (`POST /v1/catalog/import/apply`).
 *
 * ⛔ O `apply` da CLI NUNCA aplica ampliação de acesso: ela usa token (decisão do dono, 30/10 — por token o servidor
 * recusa com 403), e nem manda `confirm`. Plano com ampliação para aqui e manda para a tela.
 *
 * `GATEWAY_URL` (padrão `http://localhost:3000`) e `GATEWAY_TOKEN` (um token de acesso `agw_…` ou de sessão, de um
 * admin) vêm do ambiente; o token nunca vai na linha de comando, que fica no histórico do shell.
 */

export const CATALOG_USAGE = [
  'uso: pnpm catalog export <pasta> [--project <id> | --global] [--url <base>]',
  '     pnpm catalog plan <pasta> [--project <id> | --global] [--url <base>]',
  '     pnpm catalog apply <pasta> [--project <id> | --global] [--url <base>]',
  '  GATEWAY_URL   a base do gateway (padrão http://localhost:3000)',
  '  GATEWAY_TOKEN token de acesso (agw_…) ou de sessão de um admin',
  '  apply nunca aplica ampliação de acesso (por token, só o que não amplia): ampliação, só pela tela',
].join('\n')

export interface ICatalogCliIo {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  log: (line: string) => void
}

interface ICliArgs {
  dir: string
  project?: string
  global: boolean
  url?: string
}

function parseArgs(args: readonly string[], missing: string): ICliArgs {
  const parsed: ICliArgs = { dir: '', global: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--project') parsed.project = args[++index]
    else if (arg.startsWith('--project=')) parsed.project = arg.slice('--project='.length)
    else if (arg === '--global') parsed.global = true
    else if (arg === '--url') parsed.url = args[++index]
    else if (arg.startsWith('--url=')) parsed.url = arg.slice('--url='.length)
    else if (arg.startsWith('-')) throw new Error(`opção desconhecida: ${arg}`)
    else if (!parsed.dir) parsed.dir = arg
    else throw new Error(`argumento a mais: ${arg}`)
  }
  if (!parsed.dir) throw new Error(missing)
  if (parsed.project !== undefined && !parsed.project) throw new Error('--project pede um id')
  if (parsed.project && parsed.global) throw new Error('--project e --global não vão juntos')
  return parsed
}

type TPayload<T> = { ok?: boolean; result?: T; message?: string; code?: string; details?: unknown } | undefined

interface IClient {
  get<T>(path: string): Promise<{ status: number; payload: TPayload<T> }>
  post<T>(path: string, body: unknown): Promise<{ status: number; payload: TPayload<T> }>
}

function client(args: ICliArgs, io: ICatalogCliIo): IClient {
  const base = (args.url ?? io.env.GATEWAY_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  const token = io.env.GATEWAY_TOKEN?.trim()
  const auth: Record<string, string> = token ? { 'X-Tool-Authorization': `Bearer ${token}` } : {}
  const call = async <T>(path: string, init: RequestInit) => {
    const response = await io.fetch(`${base}${path}`, init)
    return { status: response.status, payload: (await response.json().catch(() => undefined)) as TPayload<T> }
  }
  return {
    get: (path) => call(path, { headers: auth }),
    post: (path, body) => call(path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }
}

const scopeQuery = (args: ICliArgs) => new URLSearchParams({ scope: args.project ? 'project' : args.global ? 'global' : 'all', ...(args.project ? { project: args.project } : {}) })

function failure(what: string, status: number, payload: TPayload<unknown>): string {
  const hint = status === 404 ? ' (só admin; confira o GATEWAY_TOKEN)' : ''
  return `${what} falhou: HTTP ${status}${payload?.message ? ` — ${payload.message}` : ''}${hint}`
}

/** Roda a CLI; devolve o código de saída. */
export async function runCatalogCli(argv: readonly string[], io: ICatalogCliIo): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'export' && command !== 'plan' && command !== 'apply') {
    io.log(command ? `comando desconhecido: ${command}\n${CATALOG_USAGE}` : CATALOG_USAGE)
    return 2
  }
  let args: ICliArgs
  try {
    args = parseArgs(rest, command === 'export' ? 'falta a pasta de destino' : 'falta a pasta do catálogo')
  } catch (error) {
    io.log(`${(error as Error).message}\n${CATALOG_USAGE}`)
    return 2
  }
  if (command === 'export') return exportCatalog(args, io)
  let files: TCatalogFiles
  try {
    files = readCatalogDirectory(args.dir)
  } catch (error) {
    io.log((error as Error).message)
    return 1
  }
  return command === 'plan' ? planCatalog(args, files, io) : applyCatalog(args, files, io)
}

async function exportCatalog(args: ICliArgs, io: ICatalogCliIo): Promise<number> {
  const query = new URLSearchParams({ format: 'json', ...Object.fromEntries(scopeQuery(args)) })
  const { status, payload } = await client(args, io).get<{ manifest: ICatalogManifest; files: TCatalogFiles }>(`/v1/catalog/export?${query}`)
  if (status !== 200 || !payload?.ok || !payload.result) {
    io.log(failure('export', status, payload))
    return 1
  }
  const { manifest, files } = payload.result
  const { written, removed } = writeCatalogDirectory(args.dir, files)
  io.log(`catálogo (${manifest.scope}) em ${args.dir}: ${written} arquivo(s) escrito(s), ${removed.length} removido(s) do export anterior`)
  for (const item of manifest.masked) io.log(`  mascarado: ${item.path} · ${item.field} (${item.layer}: ${item.label})`)
  return 0
}

/** O que a CLI lê do plano. */
interface IPlanView {
  scope: string
  planHash: string
  items: Array<{ ref: string; op: string; issues: Array<{ field: string; message: string }>; entersDisabled?: boolean; missingSecrets?: string[] }>
  order: Array<{ ref: string; phase: string; part?: string }>
  widenings: Array<{ key: string; description: string }>
  attentions: Array<{ description: string }>
  brokenRefs: Array<{ from: string; message: string }>
  fileErrors: Array<{ path: string; message: string }>
  summary: Record<string, number>
}

async function fetchPlan(args: ICliArgs, files: TCatalogFiles, io: ICatalogCliIo): Promise<IPlanView | undefined> {
  const { status, payload } = await client(args, io).post<IPlanView>(`/v1/catalog/import/plan?${scopeQuery(args)}`, { files })
  if (status !== 200 || !payload?.ok || !payload.result) {
    io.log(failure('plano', status, payload))
    return undefined
  }
  return payload.result
}

function printPlan(plan: IPlanView, io: ICatalogCliIo): void {
  const { summary } = plan
  io.log(
    `plano (${plan.scope}): ${summary.create ?? 0} a criar, ${summary.update ?? 0} a alterar, ${summary.unchanged ?? 0} sem mudança, ${summary.conflict ?? 0} em conflito, ${summary.error ?? 0} com erro`,
  )
  for (const error of plan.fileErrors) io.log(`  arquivo fora do formato: ${error.path} — ${error.message}`)
  for (const item of plan.items.filter((entry) => entry.op === 'error' || entry.op === 'conflict'))
    io.log(`  ${item.op === 'error' ? 'erro' : 'conflito'}: ${item.ref} — ${item.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')}`)
  for (const step of plan.order) io.log(`  ${step.phase}: ${step.ref}${step.part ? ` (${step.part})` : ''}`)
  for (const widening of plan.widenings) io.log(`  ampliação: ${widening.description} [${widening.key}]`)
  for (const attention of plan.attentions) io.log(`  atenção: ${attention.description}`)
  for (const broken of plan.brokenRefs) io.log(`  referência: ${broken.from} — ${broken.message}`)
  for (const item of plan.items.filter((entry) => entry.missingSecrets?.length))
    io.log(`  segredo faltando: ${item.ref} — ${item.missingSecrets!.join(', ')}${item.entersDisabled ? ' (entra desligado)' : ''}`)
  io.log(`  planHash ${plan.planHash}`)
}

const blocked = (plan: IPlanView) => plan.fileErrors.length > 0 || plan.items.some((item) => item.op === 'error' || item.op === 'conflict')

async function planCatalog(args: ICliArgs, files: TCatalogFiles, io: ICatalogCliIo): Promise<number> {
  const plan = await fetchPlan(args, files, io)
  if (!plan) return 1
  printPlan(plan, io)
  return blocked(plan) ? 1 : 0
}

interface IApplyView {
  batch?: { id: string; status: string }
  applied: Array<{ ref: string; part?: string }>
  failed?: { ref: string; message: string }
  pending: Array<{ ref: string }>
  missingSecrets: Array<{ ref: string; secrets: string[] }>
  revert?: { path: string }
}

async function applyCatalog(args: ICliArgs, files: TCatalogFiles, io: ICatalogCliIo): Promise<number> {
  const plan = await fetchPlan(args, files, io)
  if (!plan) return 1
  printPlan(plan, io)
  if (blocked(plan)) {
    io.log('nada aplicado: o plano tem erro ou conflito. Corrija e rode de novo.')
    return 1
  }
  if (plan.widenings.length) {
    io.log(`nada aplicado: o plano amplia acesso (${plan.widenings.length}). Por token não se aplica ampliação: aplique pela tela, como admin.`)
    return 1
  }
  if (!plan.order.length) {
    io.log('nada a aplicar: o catálogo já está como a pasta.')
    return 0
  }
  const scope = args.project ? `project:${args.project}` : args.global ? 'global' : plan.scope
  const { status, payload } = await client(args, io).post<IApplyView>('/v1/catalog/import/apply', { package: { files }, scope, planHash: plan.planHash })
  if (status !== 200 || !payload?.ok || !payload.result) {
    io.log(failure('apply', status, payload))
    if (payload?.code === 'plan_changed') io.log('o catálogo mudou desde o plano: rode de novo.')
    return 1
  }
  const result = payload.result
  io.log(`aplicado: ${result.applied.length} passo(s) no lote ${result.batch?.id ?? '-'} (${result.batch?.status ?? '-'})`)
  for (const item of result.missingSecrets) io.log(`  segredo faltando: ${item.ref} — ${item.secrets.join(', ')} (cadastre na tela do MCP)`)
  if (result.failed) {
    io.log(`  parou em ${result.failed.ref}: ${result.failed.message}; ${result.pending.length} passo(s) não aplicado(s)`)
    if (result.revert) io.log(`  para desfazer o que entrou: POST ${result.revert.path} (ou "Reverter lote" no Histórico do catálogo)`)
    return 1
  }
  return 0
}
