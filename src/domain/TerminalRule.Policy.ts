/** Os shells que, sem `-c` nem arquivo, leem o script do stdin (`bash -s < arq`). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/**
 * ⚠️ A REGRA DE TERMINAL QUE NUNCA LIBERA O QUE PARECE QUERER. O shell remoto do `ssh` lendo o script do stdin
 * (`ssh h bash -s < arq`) é uma linha que o gateway não lê: só passa com a regra EXATA, a parte remota igual à linha, sem curinga
 * (`ssh * 10.10.0.4 bash -s`). `ssh * h bash *` e `ssh * h bash -s*` parecem cobrir e nunca cobrem; e a linha remota montada pelo
 * shell local (`$(…)`, crase) nunca passa. Devolve o motivo, ou nada. Aviso, não recusa: a regra vale para o que ela casa.
 */
export function terminalRuleWarning(pattern: string): string | undefined {
  const words = pattern.trim().split(/\s+/)
  if (words[0] !== 'ssh') return undefined
  const shell = words.findIndex((word, index) => index >= 2 && SHELLS.has(word.replace(/^["']/, '')))
  const remote = shell >= 0 ? words.slice(shell) : []
  const rule = pattern.trim()
  if (/\$\(|`/.test(rule))
    return `\`${rule}\` não libera nada que o shell local monta (\`$(…)\`, crase): o texto que a regra vê não é o que o ssh recebe. Escreva a linha remota por extenso`
  if (!remote.length || remote.includes('-c') || !remote.slice(1).some((word) => /[*?]/.test(word))) return undefined
  const example = `${words.slice(0, shell).join(' ')} ${remote[0]!.replace(/^["']/, '')} -s`
  return `\`${rule}\` nunca libera script por stdin no host remoto (\`bash -s < arq\`): a linha remota que o gateway não lê só passa com a regra exata, a parte remota igual à linha e sem curinga (ex. \`${example}\`)`
}
