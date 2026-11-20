/**
 * 📐 SCHEMASTORE, EMBUTIDO: os schemas JSON dos arquivos de configuração mais comuns vão DENTRO do app (o navegador não
 * busca na internet — a CSP só aceita a própria origem). O editor valida e completa `package.json`, `tsconfig`, os
 * workflows do GitHub, o `docker-compose` etc. Cada schema é um arquivo à parte, pedido só quando um arquivo dele abre.
 *
 * Fontes: json.schemastore.org (Apache-2.0); o do Compose, do compose-spec (Apache-2.0).
 */
import type * as Monaco from 'monaco-editor'
import packageSchema from '@/schemas/package.schema.json?url'
import tsconfigSchema from '@/schemas/tsconfig.schema.json?url'
import eslintrcSchema from '@/schemas/eslintrc.schema.json?url'
import prettierrcSchema from '@/schemas/prettierrc.schema.json?url'
import workflowSchema from '@/schemas/github-workflow.schema.json?url'
import actionSchema from '@/schemas/github-action.schema.json?url'
import composeSchema from '@/schemas/docker-compose.schema.json?url'
import pnpmWorkspaceSchema from '@/schemas/pnpm-workspace.schema.json?url'

type TMonaco = typeof Monaco

/** Que arquivos usam que schema (globs sobre o caminho do arquivo no editor). */
const JSON_SCHEMAS = [
  { uri: packageSchema, fileMatch: ['**/package.json'] },
  { uri: tsconfigSchema, fileMatch: ['**/tsconfig.json', '**/tsconfig.*.json', '**/jsconfig.json'] },
  { uri: eslintrcSchema, fileMatch: ['**/.eslintrc', '**/.eslintrc.json'] },
  { uri: prettierrcSchema, fileMatch: ['**/.prettierrc', '**/.prettierrc.json'] },
]
const YAML_SCHEMAS = [
  { uri: workflowSchema, fileMatch: ['**/.github/workflows/*.yml', '**/.github/workflows/*.yaml'] },
  { uri: actionSchema, fileMatch: ['**/action.yml', '**/action.yaml'] },
  { uri: composeSchema, fileMatch: ['**/docker-compose.yml', '**/docker-compose.yaml', '**/compose.yml', '**/compose.yaml', '**/docker-compose.*.yml'] },
  { uri: pnpmWorkspaceSchema, fileMatch: ['**/pnpm-workspace.yaml'] },
  { uri: prettierrcSchema, fileMatch: ['**/.prettierrc.yml', '**/.prettierrc.yaml'] },
  { uri: eslintrcSchema, fileMatch: ['**/.eslintrc.yml', '**/.eslintrc.yaml'] },
]

/** Casa um caminho com um glob simples (`**`, `*`). */
function matches(glob: string, path: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${pattern}$`).test(path)
}

type TEntry = { uri: string; fileMatch: string[] }

/**
 * ⚖️ Referência a OUTRO schema (na internet, `https://...`, ou relativa, `eslintrc.json`) vira "qualquer coisa": o editor não busca fora, e uma
 * referência que não carrega faz o serviço do JSON desistir do schema INTEIRO (nada era validado).
 */
export function offline(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(offline)
  if (!schema || typeof schema !== 'object') return schema
  const entries = Object.entries(schema as Record<string, unknown>)
  const ref = (schema as { $ref?: unknown }).$ref
  if (typeof ref === 'string' && !ref.startsWith('#')) return Object.fromEntries(entries.filter(([key]) => key !== '$ref').map(([key, value]) => [key, offline(value)]))
  return Object.fromEntries(entries.map(([key, value]) => [key, offline(value)]))
}
const loaded = new Map<string, unknown>()
let applyJson: ((schemas: Array<TEntry & { schema: unknown }>) => void) | undefined
let applyYaml: ((schemas: Array<TEntry & { schema: unknown }>) => void) | undefined

/** Os schemas já carregados de uma lista, com o conteúdo (o worker não precisa buscar nada). */
const withContent = (list: TEntry[]) =>
  list.filter((entry) => loaded.has(entry.uri)).map((entry) => ({ ...entry, uri: new URL(entry.uri, window.location.href).toString(), schema: loaded.get(entry.uri) }))

/**
 * Ao abrir um arquivo: se algum schema vale para ele, carrega (uma vez) e entrega ao JSON e ao YAML. Assim só o schema
 * que serve vai pela rede, e o editor já valida o arquivo com ele.
 */
export async function ensureSchemaFor(path: string): Promise<void> {
  const wanted = [...JSON_SCHEMAS, ...YAML_SCHEMAS].filter((entry) => entry.fileMatch.some((glob) => matches(glob, path)) && !loaded.has(entry.uri))
  if (!wanted.length) return
  await Promise.all(
    wanted.map(async (entry) => {
      const response = await fetch(entry.uri)
      if (!response.ok) return
      // ⚠️ O `$id` (o endereço do schema na internet) faz o validador resolver os `$ref` internos a partir dele, e eles
      // não resolvem: o schema vira "aceita tudo". Sem ele, os `#/definitions/...` resolvem no próprio arquivo.
      const { $id: _id, id: _legacyId, ...schema } = (await response.json()) as Record<string, unknown>
      void _id
      void _legacyId
      loaded.set(entry.uri, offline(schema))
    }),
  )
  applyJson?.(withContent(JSON_SCHEMAS))
  applyYaml?.(withContent(YAML_SCHEMAS))
}

let ready = false
export async function registerSchemas(monaco: TMonaco): Promise<void> {
  if (ready) return
  ready = true
  const { jsonDefaults } = await import('monaco-editor/languages/features/json/register')
  applyJson = (schemas) =>
    jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
      enableSchemaRequest: false,
      // Um schema que aponta para outro na internet não vira aviso: o editor não busca fora, de propósito.
      schemaRequest: 'ignore',
      // `setDiagnosticsOptions` troca TODAS as opções: sem isto, a validação pelo schema fica desligada.
      schemaValidation: 'warning',
      schemas,
    })
  applyJson([])
  const [{ configureMonacoYaml }, { default: YamlWorker }] = await Promise.all([import('monaco-yaml'), import('monaco-yaml/yaml.worker?worker')])
  /**
   * ⚠️ O monaco-yaml pede o worker do jeito antigo (`moduleId`/`label`); o Monaco 0.56+ quer o `Worker` pronto. Aqui o
   * pedido dele vira o novo: o worker do YAML, com o mesmo aperto de mão que o Monaco faz com os dele (`ignore` e os dados).
   */
  type TLegacyWorkerOptions = { createData?: unknown; host?: Record<string, (...args: unknown[]) => unknown>; keepIdleModels?: boolean; worker?: Worker }
  const createWebWorker = (options: TLegacyWorkerOptions) => {
    if (options.worker) return monaco.editor.createWebWorker(options as Monaco.editor.IInternalWebWorkerOptions)
    const worker = new YamlWorker()
    worker.postMessage('ignore')
    worker.postMessage(options.createData)
    return monaco.editor.createWebWorker({ worker, host: options.host, keepIdleModels: options.keepIdleModels })
  }
  const yamlMonaco = { ...monaco, editor: { ...monaco.editor, createWebWorker } } as unknown as TMonaco
  const yaml = configureMonacoYaml(yamlMonaco, { enableSchemaRequest: false, validate: true, completion: true, hover: true, schemas: [] })
  applyYaml = (schemas) =>
    void yaml.update({ enableSchemaRequest: false, validate: true, completion: true, hover: true, schemas: schemas as Parameters<typeof yaml.update>[0]['schemas'] })
}
