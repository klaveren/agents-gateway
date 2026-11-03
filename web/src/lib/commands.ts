import { computed, type Ref } from 'vue'
import { useResource } from '@/composables/useResource'
import { useAgentCatalogStore } from '@/stores/agentCatalog'

/** O que o `/` oferece: as skills e os commands do agente e os documentos da conversa (`/spec:<id>` anexa o inteiro). */
export type TSlashKind = 'skill' | 'command' | 'spec' | 'adr' | 'knowledge'

/** As guias do `/`, na ordem: as skills primeiro (o padrão), depois os commands e os documentos. */
export const SLASH_TABS: ReadonlyArray<{ kind: TSlashKind; label: string }> = [
  { kind: 'skill', label: 'Skills' },
  { kind: 'command', label: 'Commands' },
  { kind: 'spec', label: 'Specs' },
  { kind: 'adr', label: 'ADRs' },
  { kind: 'knowledge', label: 'Conhecimento' },
]

/** Um item do `/` que a pessoa pode usar com o agente (o autocompletar da caixa de mensagem). */
export interface ICommandHint {
  /** O que vai depois da barra: o nome da skill ou do command, ou `<tipo>:<id>` de um documento. */
  id: string
  /** Ausente nas respostas antigas: vale `command`. */
  kind?: TSlashKind
  description: string
}

/**
 * As sugestões de cada guia para o texto digitado (ver `commandSuggestions`), até 50 por guia (a lista rola). `filter`:
 * o campo de busca do seletor — mais um recorte, no nome e na descrição, sem acento.
 */
export function slashSuggestions(text: string, commands: readonly ICommandHint[], filter = ''): Record<TSlashKind, ICommandHint[]> {
  const wanted = fold(filter.trim())
  const kept = wanted ? commands.filter((command) => fold(`${command.id} ${command.description}`).includes(wanted)) : commands
  return Object.fromEntries(
    SLASH_TABS.map(({ kind }) => [
      kind,
      commandSuggestions(
        text,
        kept.filter((command) => (command.kind ?? 'command') === kind),
        50,
      ),
    ]),
  ) as Record<TSlashKind, ICommandHint[]>
}

/**
 * A guia que aparece: a escolhida — a não ser que ela não tenha nada para o que foi digitado e outra tenha (procurar
 * "/api" com a guia Skills aberta mostra a spec, em vez de uma lista vazia). Sem nada digitado, a escolhida.
 */
export function shownSlashTab(chosen: TSlashKind, text: string, matches: Record<TSlashKind, ICommandHint[]>): TSlashKind {
  if (matches[chosen].length || text === '/') return chosen
  return SLASH_TABS.find(({ kind }) => matches[kind].length)?.kind ?? chosen
}

/** Minúsculas e sem acento: "Resumé" acha "resume". */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/**
 * A BUSCA de `/`: só quando a mensagem COMEÇA com `/` e ainda não tem espaço (a pessoa está escolhendo). O que vem
 * depois da barra procura no nome e na descrição, sem acento; os do nome que começa igual vêm primeiro, depois os do
 * nome que contém, depois os da descrição.
 */
export function commandSuggestions(text: string, commands: readonly ICommandHint[], limit = 8): ICommandHint[] {
  const match = /^\/(\S*)$/.exec(text)
  if (!match || !commands.length) return []
  const query = fold(match[1])
  const rank = (command: ICommandHint) => {
    const id = fold(command.id)
    if (id.startsWith(query)) return 0
    if (id.includes(query)) return 1
    return fold(command.description).includes(query) ? 2 : -1
  }
  return commands
    .map((command, index) => ({ command, index, score: rank(command) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.command)
}

/**
 * O que o `/` do agente oferece no projeto da conversa (os documentos são os globais e os do projeto dela), da store:
 * as telas abertas com o mesmo agente e projeto leem a mesma cópia. Sem agente, nada; falhar não atrapalha a conversa.
 */
export function useAgentCommands(agentId: Ref<string | undefined>, project?: Ref<string | undefined>): Ref<ICommandHint[]> {
  const catalog = useAgentCatalogStore()
  const { data } = useResource(catalog.commands, () => (agentId.value ? catalog.commandsKey(agentId.value, project?.value) : undefined))
  return computed(() => data.value ?? [])
}
