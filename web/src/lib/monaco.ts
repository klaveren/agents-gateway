/**
 * ✏️ O Monaco (o editor do VS Code), carregado SÓ quando o editor de arquivos abre (`import('@/lib/monaco')`): os workers
 * de linguagem saem como arquivos à parte, da mesma origem (a CSP só aceita `'self'`).
 */
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import { javascriptDefaults, typescriptDefaults } from 'monaco-editor/languages/features/typescript/register'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker }
  }
}

window.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

// O editor só mostra o arquivo: sem checagem de tipos do projeto inteiro (ele não tem as dependências), nada de erro falso.
for (const defaults of [typescriptDefaults, javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
}

/** 🎨 Monokai: a paleta clássica sobre o tema escuro do VS Code. */
monaco.editor.defineTheme('monokai', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'F8F8F2', background: '272822' },
    { token: 'comment', foreground: '75715E', fontStyle: 'italic' },
    { token: 'string', foreground: 'E6DB74' },
    { token: 'string.escape', foreground: 'AE81FF' },
    { token: 'number', foreground: 'AE81FF' },
    { token: 'constant', foreground: 'AE81FF' },
    { token: 'regexp', foreground: 'E6DB74' },
    { token: 'keyword', foreground: 'F92672' },
    { token: 'operator', foreground: 'F92672' },
    { token: 'delimiter', foreground: 'F8F8F2' },
    { token: 'type', foreground: '66D9EF', fontStyle: 'italic' },
    { token: 'type.identifier', foreground: 'A6E22E' },
    { token: 'identifier', foreground: 'F8F8F2' },
    { token: 'function', foreground: 'A6E22E' },
    { token: 'variable.parameter', foreground: 'FD971F', fontStyle: 'italic' },
    { token: 'tag', foreground: 'F92672' },
    { token: 'attribute.name', foreground: 'A6E22E' },
    { token: 'attribute.value', foreground: 'E6DB74' },
    { token: 'key', foreground: 'F92672' },
    { token: 'string.key.json', foreground: 'F92672' },
    { token: 'string.value.json', foreground: 'E6DB74' },
    { token: 'keyword.json', foreground: 'AE81FF' },
    { token: 'markup.heading', foreground: 'A6E22E', fontStyle: 'bold' },
    { token: 'keyword.md', foreground: 'F92672' },
    { token: 'string.link.md', foreground: '66D9EF' },
    { token: 'variable.md', foreground: 'FD971F' },
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#272822',
    'editor.foreground': '#F8F8F2',
    'editor.lineHighlightBackground': '#3E3D32',
    'editor.selectionBackground': '#49483E',
    'editor.inactiveSelectionBackground': '#49483E80',
    'editorCursor.foreground': '#F8F8F0',
    'editorWhitespace.foreground': '#3B3A32',
    'editorLineNumber.foreground': '#90908A',
    'editorLineNumber.activeForeground': '#F8F8F2',
    'editorIndentGuide.background1': '#3B3A32',
    'editorBracketMatch.background': '#49483E',
    'editorBracketMatch.border': '#75715E',
    'editor.findMatchBackground': '#FFE79280',
    'editor.findMatchHighlightBackground': '#FFE79240',
  },
})

export { monaco }
