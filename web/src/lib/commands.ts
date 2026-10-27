import { ref, watch, type Ref } from 'vue'
import { api } from './api'

/** Um `/command` que a pessoa pode usar com o agente (o autocompletar da caixa de mensagem). */
export interface ICommandHint {
  id: string
  description: string
}

/**
 * As sugestões para o que está na caixa: só quando a mensagem COMEÇA com `/` e ainda não tem espaço (a pessoa está
 * digitando o nome). Pelo começo do nome; o resto, pelo pedaço em qualquer lugar.
 */
export function commandSuggestions(text: string, commands: readonly ICommandHint[]): ICommandHint[] {
  const match = /^\/([a-z0-9-]*)$/.exec(text)
  if (!match || !commands.length) return []
  const query = match[1]
  const starts = commands.filter((command) => command.id.startsWith(query))
  const contains = commands.filter((command) => !command.id.startsWith(query) && command.id.includes(query))
  return [...starts, ...contains].slice(0, 8)
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
