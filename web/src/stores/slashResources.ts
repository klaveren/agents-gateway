import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { ICommandHint } from '@/lib/commands'
import { keyedResource } from '@/lib/resource'

/**
 * O `/` da caixa de mensagem (skills, commands e documentos) por AGENTE e PROJETO — a mesma cópia para toda conversa.
 *
 * ⚖️ Lido na primeira vez que o par agente+projeto aparece e GUARDADO: trocar de conversa não relê (eram 45 KB e mais de
 * um segundo a cada troca). Só o aviso do catálogo (`catalogSync`, ou uma gravação desta tela) o torna velho: o que está
 * na tela relê na hora; o resto, na próxima vez que for mostrado.
 */
export const useSlashResourcesStore = defineStore('slashResources', () => {
  const commands = keyedResource((key) => {
    const [agentId, project] = JSON.parse(key) as [string, string]
    return api<ICommandHint[]>(`/agents/${encodeURIComponent(agentId)}/commands`, { query: project ? { project } : {} })
  })
  /** As chaves que alguma tela está mostrando agora, com quantas telas (só essas relêem na hora). */
  const shown = new Map<string, number>()

  /** A chave do par (ausente = sem projeto). */
  const keyOf = (agentId: string, project?: string) => JSON.stringify([agentId, project ?? ''])

  /** Uma tela passou a mostrar a chave; devolve como deixar de mostrar. */
  function show(key: string): () => void {
    shown.set(key, (shown.get(key) ?? 0) + 1)
    return () => {
      const left = (shown.get(key) ?? 1) - 1
      if (left > 0) shown.set(key, left)
      else shown.delete(key)
    }
  }

  /** Skill, command, documento ou liberação do agente mudou: tudo fica velho, e o que está na tela relê já. */
  function changed(): void {
    commands.markAllStale()
    for (const key of shown.keys()) void commands.refresh(key).catch(() => undefined)
  }

  return { commands, keyOf, show, changed }
})
