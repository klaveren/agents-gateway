import { posix } from 'node:path'

/** A conversa em worktree: a pasta dela e o repositório principal, que o cerco abre só para leitura. */
export interface IWorktreePlace {
  dir: string
  worktree?: string
  repositoryDir?: string
}

const READ_ONLY = /Read-only file system|EROFS/
/** Um caminho absoluto no texto (até o primeiro espaço, aspas, dois-pontos ou parêntese). */
const ABSOLUTE_PATH = /(?<![\w.~-])\/[^\s'"`:;,()<>|&]+/g

/**
 * ⛔ O ERRO DE ESCRITA NO REPOSITÓRIO PRINCIPAL, NA CONVERSA EM WORKTREE: desde o #640 o cerco lê o principal (só leitura),
 * e a Vera rodava testes nele — `mkdir apps/logiccus/node_modules/.vite-temp: Read-only file system` (26/11). A nota diz
 * onde trabalhar, com o caminho equivalente na worktree quando dá para mapear. Vazio: não é esse caso.
 */
export function mainRepositoryNote(output: string, command: string, place: IWorktreePlace | undefined): string {
  if (!place?.worktree || !place.repositoryDir || !READ_ONLY.test(output)) return ''
  const main = posix.resolve(place.repositoryDir)
  const worktree = posix.resolve(place.dir)
  const inMain = (path: string) => {
    const abs = posix.resolve(path)
    return (abs === main || abs.startsWith(`${main}/`)) && abs !== worktree && !abs.startsWith(`${worktree}/`)
  }
  // O caminho da saída vem primeiro (é o que falhou); o do comando cobre o `cd <principal> && …` com saída relativa.
  const hit = [...(output.match(ABSOLUTE_PATH) ?? []), ...(command.match(ABSOLUTE_PATH) ?? [])].find(inMain)
  if (!hit) return ''
  const rest = posix.relative(main, posix.resolve(hit))
  const twin = rest ? posix.join(worktree, rest) : worktree
  return (
    `\n\nℹ️ O repositório principal (\`${main}\`) é só leitura nesta conversa: ela está na worktree \`${worktree}\`. ` +
    `Rode testes, builds e scripts lá${rest ? ` (aqui: \`${twin}\`)` : ''}, não no principal.`
  )
}
