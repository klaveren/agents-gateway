import { sensitive } from './Secret.Mask'

/**
 * Lê um arquivo `.env` (`NOME=valor`, uma por linha): os valores que a máscara da conversa registra quando o projeto libera
 * a leitura dos `.env` (ver `IProject.envFileAgents`). Ignora vazias e comentários, aceita `export NOME=…` e tira as aspas
 * que cercam o valor inteiro. Sem interpolação (`${OUTRA}` fica como está).
 */
export function parseEnvFile(text: string): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(value)
    if (quoted) value = quoted[2]!
    else value = value.replace(/\s+#.*$/, '')
    if (value) entries.push({ name: match[1]!, value })
  }
  return entries
}

/** O nome que, no `.env`, também diz segredo: chave, sal, DSN, webhook, cookie (além dos de `Secret.Mask`). */
const ENV_SECRET_NAME = /(^|_)(KEY|KEYS|SALT|DSN|WEBHOOK|COOKIE|CERT|HMAC|SEED)(_|$)|KEY$/i
/** O valor com cara de token aleatório: longo, sem ponto nem barra (não é host, caminho nem URL) e com maiúscula, minúscula e dígito. */
const RANDOM_TOKEN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_~-]{24,}$/

/**
 * ⚖️ O QUE DO `.env` VAI PARA A MÁSCARA: só o que é segredo. Mascarar tudo trocava nome de bucket, de banco, client id e URL
 * por `[segredo:…]` em todo texto da conversa — o board ficava ilegível e o agente não citava um caminho (Zeus, 16/11).
 * - O nome diz segredo (`…TOKEN`, `…SECRET`, `…PASSWORD`, `…_KEY`, `…SALT`…), e não termina em nome seguro (`…_URL`, `…_ID`);
 * - ou o valor tem cara de token aleatório (o nome não ajuda: `PAY_SK=…`);
 * - ou o valor é uma URL com senha (`mongodb://u:SENHA@h`): só a senha.
 */
export function envSecrets(text: string): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const { name, value } of parseEnvFile(text)) {
    const label = `${name} (.env)`
    const password = /:\/\/[^:/@\s]+:([^@/\s]+)@/.exec(value)?.[1]
    if (sensitive(name) || ENV_SECRET_NAME.test(name) || RANDOM_TOKEN.test(value)) out.push({ value, label })
    else if (password) out.push({ value: decodeURIComponentSafe(password), label })
  }
  return out
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
