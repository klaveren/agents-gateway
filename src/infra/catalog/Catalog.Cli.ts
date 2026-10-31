import type { ICatalogManifest, TCatalogFiles } from '@domain/Catalog.Files'
import { writeCatalogDirectory } from './Catalog.Directory'

/**
 * A CLI DO CATÁLOGO (`pnpm catalog …`, por `scripts/catalog.ts`). Por ora só `export`: pede o pacote à API
 * (`GET /v1/catalog/export?format=json`) e o escreve numa pasta — é por ela que o catálogo vai para o git. `plan` e
 * `apply` chegam com o import (PRs 8 e 9).
 *
 * `GATEWAY_URL` (padrão `http://localhost:3000`) e `GATEWAY_TOKEN` (um token de acesso `agw_…` ou de sessão, de um
 * admin) vêm do ambiente; o token nunca vai na linha de comando, que fica no histórico do shell.
 */

export const CATALOG_USAGE = [
  'uso: pnpm catalog export <pasta> [--project <id> | --global] [--url <base>]',
  '  GATEWAY_URL   a base do gateway (padrão http://localhost:3000)',
  '  GATEWAY_TOKEN token de acesso (agw_…) ou de sessão de um admin',
].join('\n')

export interface ICatalogCliIo {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  log: (line: string) => void
}

interface IExportArgs {
  dir: string
  project?: string
  global: boolean
  url?: string
}

function parseExport(args: readonly string[]): IExportArgs {
  const parsed: IExportArgs = { dir: '', global: false }
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
  if (!parsed.dir) throw new Error('falta a pasta de destino')
  if (parsed.project !== undefined && !parsed.project) throw new Error('--project pede um id')
  if (parsed.project && parsed.global) throw new Error('--project e --global não vão juntos')
  return parsed
}

/** Roda a CLI; devolve o código de saída. */
export async function runCatalogCli(argv: readonly string[], io: ICatalogCliIo): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'export') {
    io.log(command ? `comando desconhecido: ${command}\n${CATALOG_USAGE}` : CATALOG_USAGE)
    return 2
  }
  let args: IExportArgs
  try {
    args = parseExport(rest)
  } catch (error) {
    io.log(`${(error as Error).message}\n${CATALOG_USAGE}`)
    return 2
  }

  const base = (args.url ?? io.env.GATEWAY_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  const query = new URLSearchParams({ format: 'json', scope: args.project ? 'project' : args.global ? 'global' : 'all', ...(args.project ? { project: args.project } : {}) })
  const token = io.env.GATEWAY_TOKEN?.trim()
  const response = await io.fetch(`${base}/v1/catalog/export?${query}`, { headers: token ? { 'X-Tool-Authorization': `Bearer ${token}` } : {} })
  const payload = (await response.json().catch(() => undefined)) as { ok?: boolean; result?: { manifest: ICatalogManifest; files: TCatalogFiles }; message?: string } | undefined
  if (!response.ok || !payload?.ok || !payload.result) {
    const hint = response.status === 404 ? ' (só admin exporta; confira o GATEWAY_TOKEN)' : ''
    io.log(`export falhou: HTTP ${response.status}${payload?.message ? ` — ${payload.message}` : ''}${hint}`)
    return 1
  }

  const { manifest, files } = payload.result
  const { written, removed } = writeCatalogDirectory(args.dir, files)
  io.log(`catálogo (${manifest.scope}) em ${args.dir}: ${written} arquivo(s) escrito(s), ${removed.length} removido(s) do export anterior`)
  for (const item of manifest.masked) io.log(`  mascarado: ${item.path} · ${item.field} (${item.layer}: ${item.label})`)
  return 0
}
