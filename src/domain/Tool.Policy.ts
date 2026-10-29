import { capability } from './Capability.Catalog'
import { nativeTool } from './Native.Tools'

/**
 * As ferramentas que alcançam ESTE SERVIDOR: comandos (`run_bash`) e as nativas `server-*` do Claude Code
 * (Bash, Read, Write, Edit, WebFetch…). Quem conversa com um agente que as tem ganha esse alcance — a tela
 * avisa, e quem cria o agente decide se ele é só para admin (`IAgent.adminOnly`).
 */
export const DANGEROUS_LOCAL_TOOLS: readonly string[] = ['run_bash']

export function dangerousToolsOf(allowedTools: readonly string[]): string[] {
  return allowedTools.filter((tool) => DANGEROUS_LOCAL_TOOLS.includes(tool) || !!nativeTool(tool)?.risk.startsWith('server-') || !!capability(tool)?.risk.startsWith('server-'))
}
