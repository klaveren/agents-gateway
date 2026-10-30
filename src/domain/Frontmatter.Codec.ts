import type { TCanonicalBody } from './Catalog.Document'

/**
 * O CODEC DO FRONTMATTER do pacote do catálogo — só a interface: a implementação entra no PR 7 do plano
 * (docs/integration/plano-catalogo-historico.md §2.5 e §3), junto do mapeamento documento ↔ arquivos.
 *
 * ⚖️ Um SUBCONJUNTO válido como YAML, com parser próprio e sem dependência: uma linha por chave, `chave: valor`, em que o
 * valor é texto simples ou um literal JSON (`"…"`, `[…]`, `true`, números). JSON é YAML válido, então qualquer
 * ferramenta de YAML continua lendo. Chaves em ordem e LF, como o documento canônico. O importador do `.agents/`
 * (plano-importador §2.4) usa o mesmo codec, pelo `parsePackage`.
 */
export interface IFrontmatter {
  data: TCanonicalBody
  /** O markdown depois do bloco `---`. */
  body: string
}

export interface IFrontmatterCodec {
  /** ⛔ Lança em linha fora do subconjunto (YAML de bloco, âncora, multilinha): o plano mostra como erro, sem adivinhar. */
  parse(text: string): IFrontmatter
  /** Estável: a mesma entrada dá o mesmo texto, e `parse(stringify(x))` devolve `x`. */
  stringify(frontmatter: IFrontmatter): string
}
