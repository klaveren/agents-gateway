export interface ISseFrame {
  event?: string
  data: unknown
}

/**
 * Lê um corpo `text/event-stream` frame a frame.
 *
 * ⚠️ O chunk da rede não respeita fronteira de frame: um pode cortar uma linha ao meio, por isso o
 * buffer. Comentário (`: ping`) e frame sem `data` são ignorados; `data` que não é JSON também — um
 * frame estragado não pode derrubar o stream inteiro.
 *
 * ⚖️ `fetch` e não `EventSource`: o `EventSource` não manda cabeçalho, e o gateway exige a credencial
 * do chamador (`X-Tool-Authorization`) em toda rota.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ISseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function parseFrame(frame: string): ISseFrame | undefined {
  let event: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data.push(line.slice(6))
  }
  if (!data.length) return undefined

  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return undefined
  }
}
