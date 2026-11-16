/**
 * Lê um bloco no formato `.env` (`NOME=valor`, uma por linha): o que se cola para preencher as variáveis de uma vez.
 * Ignora linhas vazias e comentários (`#`), aceita `export NOME=…` e tira as aspas que cercam o valor inteiro.
 */
export function parseEnvBlock(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
    if (quoted) value = quoted[2]!
    values[match[1]!] = value
  }
  return values
}
