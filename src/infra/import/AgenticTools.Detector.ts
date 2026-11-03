import { posix } from 'node:path'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { inWorktreeCopy, memoryNotes, memoryTitle } from './Claude.Detector'

/** As ENTRADAS das outras ferramentas, na raiz: o que cada uma lê para achar o ambiente. */
const ROOT_ENTRIES = ['.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md']
/** O `GEMINI.md`, como o `CLAUDE.md`: na raiz e nas subpastas. */
const GEMINI_MD = /^gemini\.md$/i
/** As pastas das ferramentas sem detector próprio: o que mora nelas entra como desconhecido (reclassifique na tela). */
const TOOL_DIRS = ['.codex/', '.cursor/', '.github/chatmodes/', '.github/prompts/', '.github/instructions/', '.gemini/', '.windsurf/', '.clinerules/', '.roo/', '.continue/']

/**
 * As OUTRAS FERRAMENTAS do ambiente agêntico (Gemini, Cursor, Windsurf, Cline, Copilot, Codex, Roo, Continue), sem
 * formato próprio no gateway:
 * - a entrada de cada uma (`GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`)
 *   sai como o `CLAUDE.md`/`AGENTS.md`: desconhecido DE PROPÓSITO, com o motivo (`memoryNotes`, `cli-entry`);
 * - o resto das pastas delas sai desconhecido, como qualquer arquivo que nenhuma regra classifica.
 */
export class AgenticToolsDetector implements IFormatDetector {
  readonly id = 'agentic-tools'

  detects(tree: IRepoTree): boolean {
    return tree.entries().some((entry) => this.entryAs(entry.path, entry.aliases) !== undefined || this.toolFile(entry.path, entry.aliases) !== undefined)
  }

  scan(tree: IRepoTree): IDetectedItem[] {
    const items: IDetectedItem[] = []
    for (const entry of tree.entries()) {
      const path = this.entryAs(entry.path, entry.aliases)
      if (path) {
        const file = tree.read(entry.path)
        items.push({
          kind: 'unknown',
          name: path,
          title: memoryTitle(file?.text ?? '') ?? path,
          sources: [{ path: entry.path, role: 'cli-entry' }],
          notes: memoryNotes(path, file?.bytes ?? entry.bytes, posix.basename(path)),
        })
        continue
      }
      const other = this.toolFile(entry.path, entry.aliases)
      if (other) items.push({ kind: 'unknown', name: other, sources: [{ path: entry.path }] })
    }
    return items
  }

  /** O caminho (real ou por link) pelo qual o arquivo é a entrada de uma destas ferramentas, fora das cópias de trabalho. */
  private entryAs(path: string, aliases: readonly string[]): string | undefined {
    return [path, ...aliases].find((candidate) => !inWorktreeCopy(candidate) && (ROOT_ENTRIES.includes(candidate.toLowerCase()) || GEMINI_MD.test(posix.basename(candidate))))
  }

  /** O caminho pelo qual o arquivo mora numa pasta destas ferramentas. */
  private toolFile(path: string, aliases: readonly string[]): string | undefined {
    return [path, ...aliases].find((candidate) => TOOL_DIRS.some((dir) => candidate.toLowerCase().startsWith(dir)))
  }
}
