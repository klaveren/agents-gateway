import { posix } from 'node:path'
import { IDetectedItem, IFormatDetector, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { inWorktreeCopy, memoryNotes, memoryTitle } from './Claude.Detector'

const AGENTS_MD = /^agents\.md$/i

/**
 * O `AGENTS.md` (raiz e subpastas): as instruções do projeto para qualquer agente. Vira rule candidata, com a nota de
 * que também é candidato a complemento de protocolo do projeto; o de subpasta diz a pasta em que vale. As citações
 * saem do texto, como nos outros formatos.
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
        kind: 'rule',
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
