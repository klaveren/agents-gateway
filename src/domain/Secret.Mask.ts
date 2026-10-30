/**
 * ⛔ A MÁSCARA DE SEGREDOS: o que sai das ferramentas vai ao modelo (o fornecedor), ao histórico e à tela. Um `printenv`,
 * um `cat` de config ou um log que ecoa a URL do banco levaria o segredo junto. Três camadas, da mais certa à mais larga:
 *
 * 1. VALOR CONHECIDO: o que o gateway sabe que é segredo (as contas do comando, as chaves dos providers, o que se
 *    cadastrou na tela), também em base64 e a senha de dentro de uma URI (`user:senha@host`).
 * 2. FORMA: nome que diz segredo (`…PASSWORD`, `…TOKEN`, `…API_KEY`) com valor opaco, em JSON, YAML e `.env`. O nome
 *    ancora: `HOST`, `PORT`, `URL`, `…_ID` não são segredo, e mascarar dado legítimo ensina a ignorar a máscara.
 * 3. FORMATO DE TOKEN conhecido (`ghp_`, `sk-`, `AKIA`, bloco de chave privada, JWT…), venha de onde vier.
 *
 * ⚠️ A máscara pega o vazamento sem querer, não o agente que quer vazar (base64 de outro jeito, invertido, em partes).
 * Contra esse, o tipo de conta de vida curta.
 */

export interface IKnownSecret {
  value: string
  /** De onde veio (a conta, o provider, o cadastro da tela): aparece na máscara, nunca o valor. */
  label: string
}

/** Um acerto da máscara: só metadado (de onde, o nome do campo, o tamanho), nunca o valor. */
export interface IMaskHit {
  layer: 'value' | 'shape' | 'format'
  label: string
  field?: string
  length: number
}

export interface IMaskOptions {
  /** Nomes de campo que também dizem segredo, além dos de fábrica. */
  extraSecretNames?: readonly string[]
  /** Nomes que nunca são segredo, além dos de fábrica. */
  extraSafeNames?: readonly string[]
  onHit?: (hit: IMaskHit) => void
}

const MIN_LENGTH = 8

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PASS|TOKEN|APIKEY|API_KEY|PRIVATE|CREDENTIAL|SESSION|JWT|SIGNATURE|PASSPHRASE|AUTH)/i
const SAFE_NAME =
  /(HOST|PORT|USER|USERNAME|URL|URI|REGION|ZONE|DATABASE|DB|PROVIDER|NAMESPACE|SERVER|PATH|EMAIL|NAME|_ID|ID|TYPE|MODE|ENABLED|TIMEOUT|TTL|LIMIT|EXPIRES|EXPIRY|LENGTH|COUNT)$/i
/** Valor com cara de segredo codificado: opaco e longo o bastante para não ser rótulo. */
const OPAQUE = /^[A-Za-z0-9+/=_\-.~]{16,}$/

/** Os formatos de token que se reconhecem sozinhos. */
const FORMATS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'chave privada', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'token do GitHub', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { label: 'token do GitLab', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'chave de API', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'token do Google', pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  { label: 'chave do Google', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { label: 'chave da AWS', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'token do Slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
]

const tag = (label: string) => `[segredo:${label}]`

/** As formas em que um valor conhecido aparece: ele, o base64 dele e a senha de dentro de uma URI. */
export function knownForms(secrets: readonly IKnownSecret[]): IKnownSecret[] {
  const forms: IKnownSecret[] = []
  for (const secret of secrets) {
    const value = secret.value.trim()
    if (value.length < MIN_LENGTH) continue
    forms.push({ value, label: secret.label })
    forms.push({ value: Buffer.from(value).toString('base64'), label: secret.label })
    const password = /:\/\/[^:/@\s]+:([^@/\s]+)@/.exec(value)?.[1]
    if (password && password.length >= MIN_LENGTH) forms.push({ value: password, label: secret.label })
  }
  // O mais longo primeiro: um segredo que contém outro é trocado inteiro.
  return forms.sort((a, b) => b.value.length - a.value.length)
}

/**
 * O texto com as três camadas aplicadas. `known` já vem das `knownForms`. Nunca lança: a máscara não pode derrubar uma
 * ferramenta.
 */
export function maskText(text: string, known: readonly IKnownSecret[], options: IMaskOptions = {}): string {
  if (!text) return text
  try {
    let out = text
    for (const secret of known) {
      if (!out.includes(secret.value)) continue
      out = out.split(secret.value).join(tag(secret.label))
      options.onHit?.({ layer: 'value', label: secret.label, length: secret.value.length })
    }
    out = maskShape(out, options)
    for (const format of FORMATS) {
      out = out.replace(format.pattern, (match) => {
        options.onHit?.({ layer: 'format', label: format.label, length: match.length })
        return tag(format.label)
      })
    }
    return out
  } catch {
    return text
  }
}

function sensitive(name: string, options: IMaskOptions): boolean {
  const clean = name.replace(/^["']|["']$/g, '')
  if ((options.extraSafeNames ?? []).some((safe) => clean.toUpperCase().endsWith(safe.toUpperCase()))) return false
  if ((options.extraSecretNames ?? []).some((secret) => clean.toUpperCase().includes(secret.toUpperCase()))) return true
  return SECRET_NAME.test(clean) && !SAFE_NAME.test(clean)
}

/** A camada 2: `"NOME": "valor"`, `NOME: valor`, `NOME=valor` — quando o nome diz segredo e o valor é opaco. */
function maskShape(text: string, options: IMaskOptions): string {
  const hit = (field: string, value: string) => {
    options.onHit?.({ layer: 'shape', label: field, field, length: value.length })
    return tag(field)
  }
  let out = text.replace(/"([A-Za-z0-9_.-]+)"\s*:\s*"([^"\\]{8,})"/g, (whole, name: string, value: string) =>
    sensitive(name, options) && OPAQUE.test(value) ? `"${name}": "${hit(name, value)}"` : whole,
  )
  out = out.replace(
    /^([ \t]*(?:export[ \t]+)?)([A-Za-z0-9_.-]+)([ \t]*[:=][ \t]*)(["']?)([^\s"']{8,})\4[ \t]*,?[ \t]*$/gm,
    (whole, indent: string, name: string, sep: string, _quote: string, value: string) =>
      sensitive(name, options) && OPAQUE.test(value) ? `${indent}${name}${sep}${hit(name, value)}` : whole,
  )
  return out
}

/** A saída estruturada (MCP): desce nos objetos, e o nome da chave ancora a forma como nas linhas. */
export function maskDeep(value: unknown, known: readonly IKnownSecret[], options: IMaskOptions = {}, key?: string, depth = 0): unknown {
  if (depth > 12) return value
  if (typeof value === 'string') {
    if (key && sensitive(key, options) && OPAQUE.test(value)) {
      options.onHit?.({ layer: 'shape', label: key, field: key, length: value.length })
      return tag(key)
    }
    return maskText(value, known, options)
  }
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, known, options, key, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskDeep(item, known, options, name, depth + 1)]))
  return value
}

/** ⛔ O comando que DESPEJA o segredo do cluster: `kubectl get secret` com saída que imprime o `data`. Não roda. */
export function dumpsClusterSecret(command: string): boolean {
  if (!/\bkubectl\b[^\n;|&]*\bget\b[^\n;|&]*\bsecrets?\b/i.test(command)) return false
  return [/(?:-o|--output)[=\s]+(?:json|yaml)\b/i, /jsonpath[^\n]*\bdata\b/i, /go-template[^\n]*\bdata\b/i, /(?:-o|--output)[=\s]+jsonpath/i].some((pattern) =>
    pattern.test(command),
  )
}

export const CLUSTER_SECRET_REFUSAL = [
  'Recusado: este comando imprime o `data` de um Secret do Kubernetes (base64 é codificação, não cifra), e o valor iria',
  'inteiro para o modelo e para o histórico. Para saber QUAIS chaves existem, sem os valores:',
  '  kubectl -n <namespace> describe secret <nome>',
  'Precisa do valor? Quem lê é uma pessoa, fora da conversa.',
].join('\n')
