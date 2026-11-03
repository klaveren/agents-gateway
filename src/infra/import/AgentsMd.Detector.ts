import { posix } from 'node:path'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { inWorktreeCopy, memoryNotes, memoryTitle } from './Claude.Detector'

const AGENTS_MD = /^agents\.md$/i

/**
 * O `AGENTS.md` (raiz e subpastas): a ENTRADA das CLIs que o leem (Codex, opencode…) — sai como desconhecido, com o
 * motivo (`memoryNotes`): no gateway quem faz esse papel é o próprio gateway. O de subpasta diz a pasta em que vale.
 */
export class AgentsMdDetector implements IFormatDetector {
  readonly id = 'agents-md'

  detects(tree: IRepoTree): boolean {
    return tree.entries().some((entry) => this.seenAs(entry.path, entry.aliases) !== undefined)
  }

  scan(tree: IRepoTree): IDetectedItem[] {
    const items: IDetectedItem[] = []
    for (const entry of tree.entries()) {
      const path = this.seenAs(entry.path, entry.aliases)
      if (!path) continue
      const file = tree.read(entry.path)
      items.push({
        kind: 'unknown',
        name: path,
        title: memoryTitle(file?.text ?? '') ?? path,
        sources: [{ path: entry.path, role: 'agents-md' }],
        notes: memoryNotes(path, file?.bytes ?? entry.bytes, 'AGENTS.md'),
      })
    }
    return items
  }

  /** O caminho (real ou por link) pelo qual o arquivo é um `AGENTS.md`, fora das cópias de trabalho. */
  private seenAs(path: string, aliases: readonly string[]): string | undefined {
    return [path, ...aliases].find((candidate) => AGENTS_MD.test(posix.basename(candidate)) && !inWorktreeCopy(candidate))
  }
}
