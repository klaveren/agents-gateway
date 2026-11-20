/**
 * ✨ O Prettier do editor de arquivos, rodando NO NAVEGADOR (a versão standalone): nada executa no servidor, e a config
 * vem do repositório como DADO (`.prettierrc` em JSON ou YAML, ou a chave `prettier` do `package.json`) — config em JS
 * (`prettier.config.js`) não é lida, porque seria código do repositório. Carregado só quando alguém formata.
 */
import type { Options, Plugin } from 'prettier'

/** O parser de cada extensão; sem parser, o arquivo não é formatado. */
const PARSERS: Record<string, string> = {
  js: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  jsx: 'babel',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json5',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  graphql: 'graphql',
  gql: 'graphql',
}

export function parserFor(path: string): string | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'package.json' || name === 'composer.json') return 'json-stringify'
  return PARSERS[name.split('.').pop() ?? '']
}

let plugins: Promise<Plugin[]> | undefined
function loadPlugins(): Promise<Plugin[]> {
  plugins ??= Promise.all([
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/typescript'),
    import('prettier/plugins/postcss'),
    import('prettier/plugins/html'),
    import('prettier/plugins/markdown'),
    import('prettier/plugins/yaml'),
    import('prettier/plugins/graphql'),
  ]).then((modules) => modules.map((module) => (module as { default?: Plugin }).default ?? (module as unknown as Plugin)))
  return plugins
}

/** Lê a config do repositório: o texto do `.prettierrc` (JSON ou YAML) ou o `package.json`. `undefined`: sem config. */
export async function parseConfig(source: { name: string; content: string }): Promise<Options | undefined> {
  const text = source.content.trim()
  if (!text) return undefined
  if (source.name === 'package.json') {
    const prettier = (JSON.parse(text) as { prettier?: unknown }).prettier
    return prettier && typeof prettier === 'object' ? (prettier as Options) : undefined
  }
  if (text.startsWith('{')) return JSON.parse(text) as Options
  const { parse } = await import('yaml')
  const parsed = parse(text) as unknown
  return parsed && typeof parsed === 'object' ? (parsed as Options) : undefined
}

/** Só as opções de formato: nada de `plugins` ou `overrides` vindos do repositório (plugin é código). */
function safeOptions(config: Options | undefined): Options {
  if (!config) return {}
  const { plugins: _plugins, overrides: _overrides, ...rest } = config as Options & { overrides?: unknown }
  void _plugins
  void _overrides
  return rest
}

export async function formatText(path: string, text: string, config: Options | undefined): Promise<string | undefined> {
  const parser = parserFor(path)
  if (!parser) return undefined
  const [{ format }, loaded] = await Promise.all([import('prettier/standalone'), loadPlugins()])
  return format(text, { ...safeOptions(config), parser, plugins: loaded, filepath: path })
}
