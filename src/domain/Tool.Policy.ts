import { nativeTool } from './Native.Tools'

/**
 * As ferramentas que alcançam ESTE SERVIDOR: comandos (`run_bash`) e as nativas `server-*` do Claude Code
 * (Bash, Read, Write, Edit, WebFetch…). Quem conversa com um agente que as tem ganha esse alcance.
 */
export const DANGEROUS_LOCAL_TOOLS: readonly string[] = ['run_bash']

export function dangerousToolsOf(allowedTools: readonly string[]): string[] {
  return allowedTools.filter((tool) => DANGEROUS_LOCAL_TOOLS.includes(tool) || !!nativeTool(tool)?.risk.startsWith('server-'))
}

/** ⚖️ Ligado por padrão: agente com ferramenta perigosa só conversa com administrador. `0` desliga. */
export function dangerousToolsAdminOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DANGEROUS_TOOLS_ADMIN_ONLY?.trim() !== '0'
}
