/**
 * ⚖️ A EDIÇÃO nasce no build e não muda: `VITE_EDITION=lite npm run dev` (ou `vite build`) monta a tela reduzida. Só
 * a tela: o servidor é o mesmo e não barra nada (a lite é para apresentação).
 */
export const lite = import.meta.env.VITE_EDITION === 'lite'

/** As rotas da lite: o resto volta para `/`. As telas são as da PRO, sem mudança; o que a lite mostra mora aqui e no `LiteNav`. */
export const LITE_ROUTES: ReadonlySet<string> = new Set([
  'inbox',
  'conversation',
  'conversation-panel',
  'new',
  'agents',
  'agent-new',
  'agent',
  'providers',
  'provider-new',
  'provider',
  'profile',
  'usage',
  'login',
  'setup',
])

/** As guias do agente que a lite esconde (ver `AgentForm`): o resto do formulário é o mesmo. */
export const LITE_HIDDEN_AGENT_TABS: ReadonlySet<string> = new Set(['triggers', 'recursos', 'arquivos', 'contexto', 'hooks', 'agendamentos'])
