import type { TCatalogScope } from '@application/Catalog.Reader'
import { canonicalize, catalogHash, ICatalogDocument, TCanonicalBody, TCanonicalValue, TCatalogKind } from '@domain/Catalog.Document'
import {
  CATALOG_FORMAT,
  catalogFiles,
  fileHash,
  fileOfField,
  flattenFiles,
  ICatalogManifest,
  ICatalogMasked,
  manifestText,
  MANIFEST_PATH,
  TCatalogFiles,
} from '@domain/Catalog.Files'
import { ProjectNotFoundError } from '@domain/errors/Domain.Error'
import type { IMaskHit } from '@domain/Secret.Mask'

/** A máscara de segredos do gateway (`SecretMasker.scan`): o valor mascarado e os acertos desta chamada. */
export interface ISecretScanner {
  scan(value: string, key?: string): { text: string; hits: IMaskHit[] }
}

export interface ICatalogExportDeps {
  reader: {
    list(scope: TCatalogScope): ICatalogDocument[]
    read(kind: TCatalogKind, id: string, projectId?: string): ICatalogDocument | undefined
  }
  mask: ISecretScanner
  /** A versão do gateway, para o manifesto. */
  version?: string
  now?: () => Date
}

/** O pacote: o manifesto e os arquivos (o `catalog.json` incluso), pelo caminho em ordem. */
export interface ICatalogPackage {
  manifest: ICatalogManifest
  files: TCatalogFiles
}

/**
 * ⚖️ Campos que são CHAVE ou REFERÊNCIA (ids de outros itens): não passam pela máscara — trocar um id quebraria o
 * vínculo, e um id é slug validado no cadastro, não texto livre. `secrets` são só os nomes do que o MCP pede ao cofre.
 */
const UNMASKED_TOP = new Set(['id', 'projectId', 'kind', 'docIds', 'docRefs', 'initialContext', 'resources', 'secrets'])

const FLAG_WITH_VALUE = /^(-{1,2})([A-Za-z][A-Za-z0-9_.-]*)=(.+)$/s
const FLAG_ALONE = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/
const URL_PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^/?#@\s:]*):([^@/?#\s]+)@/i
const URL_QUERY = /([?&])([^=&#\s]+)=([^&#\s]*)/g

interface IFieldHit {
  field: string
  layer: IMaskHit['layer']
  label: string
}

/** O nome de uma flag ou parâmetro como nome de variável (`--api-key` → `api_key`), para a forma ancorar. */
const asName = (flag: string) => flag.replace(/-/g, '_')

/**
 * O EXPORT DO CATÁLOGO (docs/integration/plano-catalogo-historico.md §2.5, PR 7): os documentos canônicos do escopo em
 * arquivos (`Catalog.Files`), com um manifesto que leva o hash de cada arquivo e o relatório do que foi mascarado.
 *
 * ⛔ SEGREDO NUNCA SAI. O documento canônico já não tem valor de segredo (lista de campos permitidos); ainda assim, todo
 * texto do documento passa pela máscara do gateway (valor conhecido, forma e formato de token) — o corpo de uma skill, o
 * prompt e o `env` do agente, a `url` e os `args` do MCP. Na URL, a senha do `user:senha@` sai sempre, e o parâmetro da
 * query passa pela forma com o nome dele; nos `args`, `--nome=valor` e `--nome valor` também. O relatório diz o arquivo,
 * o campo e a camada — nunca o valor.
 */
export class CatalogExportUseCase {
  constructor(private readonly deps: ICatalogExportDeps) {}

  run(scope: TCatalogScope, by?: string): ICatalogPackage {
    if (scope.kind === 'project' && !this.deps.reader.read('project', scope.projectId)) throw new ProjectNotFoundError(scope.projectId)
    const masked = this.deps.reader.list(scope).map((document) => this.masked(document))
    const entries = catalogFiles(masked.map((item) => item.document))

    const report: ICatalogMasked[] = []
    const seen = new Set<string>()
    entries.forEach((entry, index) => {
      const { kind, id, projectId } = entry.document
      for (const hit of masked[index].hits) {
        const item: ICatalogMasked = { path: fileOfField(entry, hit.field), kind, id, ...(projectId ? { projectId } : {}), field: hit.field, layer: hit.layer, label: hit.label }
        const key = JSON.stringify(item)
        if (seen.has(key)) continue
        seen.add(key)
        report.push(item)
      }
    })

    const files = flattenFiles(entries)
    const manifest: ICatalogManifest = {
      format: CATALOG_FORMAT,
      scope: scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind,
      ...(this.deps.version ? { gateway: this.deps.version } : {}),
      exportedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      ...(by ? { exportedBy: by } : {}),
      files: Object.fromEntries(
        Object.keys(files)
          .sort()
          .map((path) => [path, fileHash(files[path])]),
      ),
      masked: report,
    }
    files[MANIFEST_PATH] = manifestText(manifest)
    return {
      manifest,
      files: Object.fromEntries(
        Object.keys(files)
          .sort()
          .map((path) => [path, files[path]]),
      ),
    }
  }

  /** O documento com os textos mascarados (o `text`/`hash` refeitos) e os acertos, pelo caminho do campo. */
  private masked(document: ICatalogDocument): { document: ICatalogDocument; hits: IFieldHit[] } {
    const hits: IFieldHit[] = []
    const body: TCanonicalBody = {}
    for (const [key, value] of Object.entries(document.body)) {
      body[key] = UNMASKED_TOP.has(key) ? value : this.walk(value, key, key, hits)
    }
    if (!hits.length) return { document, hits }
    const text = canonicalize(body)
    return { document: { ...document, body, text, hash: catalogHash(text) }, hits }
  }

  private walk(value: TCanonicalValue, key: string, field: string, hits: IFieldHit[]): TCanonicalValue {
    if (typeof value === 'string') return this.text(value, key, field, hits)
    if (Array.isArray(value)) {
      if (key === 'args') return this.args(value, field, hits)
      return value.map((item, index) => this.walk(item, key, `${field}[${index}]`, hits))
    }
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.walk(item, name, `${field}.${name}`, hits)]))
    return value
  }

  /** A máscara do gateway com o nome do campo; e, se for URL, a senha e a query. */
  private text(value: string, key: string, field: string, hits: IFieldHit[]): string {
    const scanned = this.scan(value, key, field, hits)
    return this.url(scanned, field, hits)
  }

  private scan(value: string, key: string | undefined, field: string, hits: IFieldHit[]): string {
    const { text, hits: found } = this.deps.mask.scan(value, key)
    for (const hit of found) hits.push({ field, layer: hit.layer, label: hit.label })
    return text
  }

  private url(value: string, field: string, hits: IFieldHit[]): string {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    let out = value.replace(URL_PASSWORD, (whole, prefix: string, password: string) => {
      // Já mascarada pelo valor conhecido: um acerto só.
      if (password.startsWith('[segredo:')) return whole
      hits.push({ field, layer: 'shape', label: 'senha na URL' })
      return `${prefix}:[segredo:senha na URL]@`
    })
    out = out.replace(URL_QUERY, (whole, sep: string, name: string, param: string) => {
      if (!param) return whole
      const masked = this.scan(param, asName(name), field, hits)
      return masked === param ? whole : `${sep}${name}=${masked}`
    })
    return out
  }

  /** `args`: cada um pela máscara; `--nome=valor` e o valor depois de `--nome` também pela forma, com o nome da flag. */
  private args(values: TCanonicalValue[], field: string, hits: IFieldHit[]): TCanonicalValue[] {
    return values.map((item, index) => {
      const itemField = `${field}[${index}]`
      if (typeof item !== 'string') return this.walk(item, 'args', itemField, hits)
      const withValue = FLAG_WITH_VALUE.exec(item)
      if (withValue) {
        const [, dashes, name, raw] = withValue
        return `${dashes}${name}=${this.text(raw, asName(name), itemField, hits)}`
      }
      const previous = index > 0 ? values[index - 1] : undefined
      const flag = typeof previous === 'string' ? FLAG_ALONE.exec(previous)?.[1] : undefined
      return this.text(item, flag ? asName(flag) : 'args', itemField, hits)
    })
  }
}
