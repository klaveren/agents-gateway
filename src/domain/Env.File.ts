/**
 * Lê um arquivo `.env` (`NOME=valor`, uma por linha): os valores que a máscara da conversa registra quando o projeto libera
 * a leitura dos `.env` (ver `IProject.readEnvFiles`). Ignora vazias e comentários, aceita `export NOME=…` e tira as aspas
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
