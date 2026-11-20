/**
 * 🗂️ Os ícones de arquivo e pasta do Material Icon Theme (o mesmo do VS Code), carregados SÓ com o editor de arquivos
 * (`import('@/lib/fileIcons')`). O mapa diz o ícone de cada nome/extensão; o SVG é um arquivo à parte, pedido quando aparece.
 */
import manifest from 'material-icon-theme/dist/material-icons.json'

const urls = import.meta.glob('/node_modules/material-icon-theme/icons/*.svg', { query: '?no-inline', import: 'default', eager: true }) as Record<string, string>
const byName = new Map(
  Object.entries(urls).map(([path, url]) => [
    path
      .split('/')
      .pop()!
      .replace(/\.svg$/, ''),
    url,
  ]),
)

interface IManifest {
  iconDefinitions: Record<string, { iconPath: string }>
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  file: string
  folder: string
  folderExpanded: string
}
const icons = manifest as unknown as IManifest

function urlOf(id: string | undefined): string | undefined {
  const path = id ? icons.iconDefinitions[id]?.iconPath : undefined
  return path
    ? byName.get(
        path
          .split('/')
          .pop()!
          .replace(/\.svg$/, ''),
      )
    : undefined
}

/** O ícone de um arquivo: o nome exato, depois a extensão mais longa (`d.ts` antes de `ts`), senão o genérico. */
export function fileIcon(path: string): string | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const exact = icons.fileNames[name]
  if (exact) return urlOf(exact)
  const parts = name.split('.')
  for (let index = 1; index < parts.length; index += 1) {
    const id = icons.fileExtensions[parts.slice(index).join('.')]
    if (id) return urlOf(id)
  }
  return urlOf(icons.file)
}

export function folderIcon(path: string, open: boolean): string | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  return urlOf((open ? icons.folderNamesExpanded[name] : icons.folderNames[name]) ?? (open ? icons.folderExpanded : icons.folder))
}
