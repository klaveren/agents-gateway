import type { TCanonicalBody, TCanonicalValue } from './Catalog.Document'

/**
 * O CODEC DO FRONTMATTER do pacote do catálogo (docs/integration/plano-catalogo-historico.md §2.5, PR 7).
 *
 * ⚖️ Um SUBCONJUNTO válido como YAML, com parser próprio e sem dependência: uma linha por chave, `chave: valor`, em que o
 * valor é texto simples ou um literal JSON (`"…"`, `[…]`, `{…}`, `true`, números). JSON é YAML válido, então qualquer
 * ferramenta de YAML continua lendo. Chaves em ordem e LF, como o documento canônico. O importador do `.agents/`
 * (plano-importador §2.4) usa o mesmo codec, pelo `parsePackage`.
 *
 * O texto simples só sai quando qualquer leitor de YAML o leria como o MESMO texto (`isPlainText`); o resto sai como
 * string JSON, com aspas. Multilinha é string JSON com `\n`: bloco `|`/`>` está fora do subconjunto.
 */
export interface IFrontmatter {
  data: TCanonicalBody
  /** O markdown depois do bloco `---`, byte a byte (um `---` no corpo é só texto). */
  body: string
}

export interface IFrontmatterCodec {
  /** ⛔ Lança em linha fora do subconjunto (YAML de bloco, âncora, multilinha): o plano mostra como erro, sem adivinhar. */
  parse(text: string): IFrontmatter
  /** Estável: a mesma entrada dá o mesmo texto, e `parse(stringify(x))` devolve `x`. */
  stringify(frontmatter: IFrontmatter): string
}

export class FrontmatterError extends Error {
  constructor(
    message: string,
    /** A linha do arquivo (1 = a primeira), quando a culpa é de uma. */
    readonly line?: number,
  ) {
    super(line ? `frontmatter, linha ${line}: ${message}` : `frontmatter: ${message}`)
    this.name = 'FrontmatterError'
  }
}

const FENCE = '---'
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/
/** O número do JSON, inteiro: `1.0`, `-2`, `3e5`. (`0x10`, `.5`, `+1` não são JSON; também não passam por texto simples.) */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
/**
 * Texto simples, sem aspas: começa por letra (ou `_`), segue com letra, número, espaço e uma pontuação curta que o YAML
 * não interpreta no meio do valor. Sem `:` e `#` (`a: b` e ` #` mudam o sentido em YAML), sem espaço nas pontas.
 */
const PLAIN = /^[\p{L}_][\p{L}\p{M}\p{N} _.,()/+'-]*$/u
/** O que o YAML 1.1 ou 1.2 leria como booleano ou nulo. */
const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null)$/i

/** `value` sai sem aspas e volta igual, em qualquer leitor de YAML? */
export function isPlainText(value: string): boolean {
  return value === value.trim() && !value.includes('  ') && PLAIN.test(value) && !YAML_RESERVED.test(value)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortKeys(value: TCanonicalValue): TCanonicalValue {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byText)
        .map((key) => [key, sortKeys(value[key])]),
    )
  }
  return value
}

function formatValue(key: string, value: TCanonicalValue): string {
  if (typeof value === 'string') return isPlainText(value) ? value : JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FrontmatterError(`${key}: número não finito`)
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return String(value)
  // Lista e objeto: JSON numa linha só, com as chaves em ordem (é um fluxo `[…]`/`{…}` do YAML).
  return JSON.stringify(sortKeys(value))
}

function parseValue(raw: string, line: number): TCanonicalValue {
  if (!raw) throw new FrontmatterError('valor vazio (em YAML seria nulo)', line)
  const first = raw[0]
  if (first === '"' || first === '[' || first === '{' || raw === 'true' || raw === 'false' || JSON_NUMBER.test(raw)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new FrontmatterError(`literal JSON inválido: ${raw.slice(0, 40)}`, line)
    }
    if (!isCanonical(parsed)) throw new FrontmatterError('null não entra no frontmatter', line)
    return parsed
  }
  if (!isPlainText(raw)) throw new FrontmatterError(`valor fora do subconjunto (use aspas de JSON): ${raw.slice(0, 40)}`, line)
  return raw
}

function isCanonical(value: unknown): value is TCanonicalValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isCanonical)
  if (value && typeof value === 'object') return Object.values(value).every(isCanonical)
  return false
}

/** `---`, as linhas `chave: valor` com as chaves em ordem, `---` e o corpo como está. LF. */
export function stringifyFrontmatter({ data, body }: IFrontmatter): string {
  const lines = Object.keys(data)
    .sort(byText)
    .map((key) => {
      if (!KEY.test(key)) throw new FrontmatterError(`chave fora do subconjunto: ${key}`)
      return `${key}: ${formatValue(key, data[key])}`
    })
  return [FENCE, ...lines, FENCE, ''].join('\n') + body
}

/**
 * O inverso do `stringifyFrontmatter`. Sem bloco no começo (`---` na primeira linha), o texto inteiro é o corpo e não há
 * metadado. O bloco termina no PRIMEIRO `---` sozinho numa linha; o que vem depois é o corpo, byte a byte.
 */
export function parseFrontmatter(text: string): IFrontmatter {
  if (!text.startsWith(`${FENCE}\n`)) {
    if (text.startsWith(`${FENCE}\r\n`)) throw new FrontmatterError('quebra de linha CRLF: o pacote usa LF', 1)
    return { data: {}, body: text }
  }
  const data: TCanonicalBody = {}
  let offset = FENCE.length + 1
  for (let line = 2; ; line++) {
    const end = text.indexOf('\n', offset)
    if (end < 0) throw new FrontmatterError('bloco sem o `---` de fechamento')
    const content = text.slice(offset, end)
    offset = end + 1
    if (content === FENCE) return { data, body: text.slice(offset) }
    if (content.endsWith('\r')) throw new FrontmatterError('quebra de linha CRLF: o pacote usa LF', line)
    const colon = content.indexOf(': ')
    const key = colon < 0 ? content.replace(/:$/, '') : content.slice(0, colon)
    if (!KEY.test(key)) throw new FrontmatterError(`linha fora do subconjunto (só \`chave: valor\`): ${content.slice(0, 40)}`, line)
    if (key in data) throw new FrontmatterError(`chave repetida: ${key}`, line)
    data[key] = parseValue(colon < 0 ? '' : content.slice(colon + 2), line)
  }
}

export const frontmatterCodec: IFrontmatterCodec = { parse: parseFrontmatter, stringify: stringifyFrontmatter }
