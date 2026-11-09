/**
 * ⚖️ A EDIÇÃO nasce no build e não muda: `VITE_EDITION=lite npm run dev` (ou `vite build`) monta a tela reduzida. Só
 * a tela: o servidor é o mesmo e não barra nada (a lite é para apresentação).
 */
export const lite = import.meta.env.VITE_EDITION === 'lite'

/** As rotas da lite: o resto volta para `/`. As telas são as da PRO, sem mudança; o que a lite mostra mora aqui e no `LiteNav`. */
export const LITE_ROUTES: ReadonlySet<string> = new Set(['inbox', 'conversation', 'conversation-panel', 'new', 'agents', 'agent-new', 'agent', 'profile', 'login', 'setup'])
