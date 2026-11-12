import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A SAÍDA GRANDE que o CLI do Claude guarda em disco: acima de ~50 KB, o resultado de uma ferramenta vai para
 * `<config>/projects/<pasta do cwd>/<sessão do CLI>/tool-results/` e o modelo recebe só o caminho e uma prévia.
 * ⛔ A pasta fica nos dados do gateway (ou na pasta pessoal), que o agente não lê. Aqui fica anotado qual é a de CADA
 * conversa, para liberar só ela, só para leitura: a transcrição (`.jsonl`) e as outras conversas continuam fechadas.
 */
interface ICliPlace {
  configDir: string
  cwd: string
  cliSessionId: string
}

/** O teto de conversas anotadas: a mais antiga sai. */
const MAX_TRACKED = 2000

const places = new Map<string, ICliPlace>()

/** O nome que o CLI dá à pasta de um `cwd`: o que não é letra nem dígito vira `-`. */
const slugOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const realOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Anota onde o CLI guarda a saída da conversa `sessionId` (a cada turno: o id do CLI muda quando a conversa recomeça). */
export function trackCliToolResults(sessionId: string, place: ICliPlace): void {
  places.delete(sessionId)
  places.set(sessionId, place)
  if (places.size > MAX_TRACKED) places.delete(places.keys().next().value as string)
}

/** A pasta `tool-results` da conversa, se o CLI já a criou. ⛔ Só a dela: o id não vira caminho se tiver outra coisa além de letra, dígito, `_` e `-`. */
export function cliToolResultDirs(sessionId: string | undefined): string[] {
  const place = sessionId ? places.get(sessionId) : undefined
  if (!place || !/^[\w-]+$/.test(place.cliSessionId)) return []
  const slugs = [...new Set([slugOf(place.cwd), slugOf(realOf(place.cwd))])]
  return slugs.map((slug) => join(place.configDir, 'projects', slug, place.cliSessionId, 'tool-results')).filter((dir) => existsSync(dir))
}

/** Só para os testes. */
export function forgetCliToolResults(): void {
  places.clear()
}
