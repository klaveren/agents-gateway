import { ref, watch, type Ref } from 'vue'
import { api } from './api'

/** Um `/command` ou uma skill que a pessoa pode usar com o agente (o autocompletar da caixa de mensagem). */
export interface ICommandHint {
  id: string
  /** Ausente nas respostas antigas: vale `command`. */
  kind?: 'command' | 'skill'
  description: string
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
export function commandSuggestions(text: string, commands: readonly ICommandHint[]): ICommandHint[] {
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
    .slice(0, 8)
    .map((item) => item.command)
}

/** Os commands do agente, buscados quando ele muda. Sem agente, nenhum; falhar não atrapalha a conversa. */
export function useAgentCommands(agentId: Ref<string | undefined>): Ref<ICommandHint[]> {
  const commands = ref<ICommandHint[]>([])
  watch(
    agentId,
    async (id) => {
      commands.value = []
      if (!id) return
      const list = await api<ICommandHint[]>(`/agents/${encodeURIComponent(id)}/commands`).catch(() => [])
      if (agentId.value === id) commands.value = list
    },
    { immediate: true },
  )
  return commands
}
