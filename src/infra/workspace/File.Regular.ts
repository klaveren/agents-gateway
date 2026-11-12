import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

/**
 * ⛔ Lê um arquivo comum sem seguir link nem esperar um FIFO: entre a conferência do caminho e a leitura, quem escreve
 * na pasta (o agente) pode trocar o arquivo. O tamanho é conferido ANTES de ler, no MESMO descritor (um arquivo enorme
 * não vai para a memória). Nada se não for arquivo comum ou passar do teto.
 */
export function readRegular(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= maxBytes ? readFileSync(fd) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
