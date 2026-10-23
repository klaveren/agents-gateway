/**
 * `import()` de verdade num projeto CommonJS.
 *
 * ⚠️ O `tsc` com `module: commonjs` reescreve `await import(x)` como `require(x)` — e há pacote que só
 * exporta a condição `import` (o `@openai/codex-sdk`): o `require` falha com
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Montado em runtime, o `import()` escapa da reescrita.
 */

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export function esmImport<T>(specifier: string): Promise<T> {
  return dynamicImport<T>(specifier)
}
