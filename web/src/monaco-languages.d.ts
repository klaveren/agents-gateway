/** A definição de HTML do Monaco (Monarch), reaproveitada para `.vue` (ver `@/lib/editorExtras`). */
declare module 'monaco-editor/languages/definitions/html/html' {
  import type { languages } from 'monaco-editor'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}
