export enum EProvider {
  CLAUDE = 'claude',
  OPENAI = 'openai',
  GOOGLE = 'google',
  /** Claude pela assinatura (Pro/Max): o Claude Agent SDK com o login do host, sem chave de API. */
  CLAUDE_SUB = 'claude-sub',
  /** ChatGPT pela assinatura: o Codex SDK com o login de `codex login`. */
  CODEX = 'codex',
  /** Google pela assinatura: o Antigravity CLI (`agy`) com o login dele. */
  ANTIGRAVITY = 'antigravity',
}
