import { describe, expect, it } from 'vitest'
import { parseFrame, readSse } from './sse'

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

describe('readSse', () => {
  it('remonta o frame que o chunk cortou ao meio, e ignora comentário e JSON quebrado', async () => {
    const frames = []
    for await (const frame of readSse(streamOf([': ready\n\n', 'id: 1\nevent: a\ndata: {"x"', ':1}\n\ndata: {quebrado\n\n', 'data: {"y":2}\n\n']))) frames.push(frame)

    expect(frames).toEqual([
      { event: 'a', data: { x: 1 } },
      { event: undefined, data: { y: 2 } },
    ])
  })

  it('frame sem data não vira evento', () => {
    expect(parseFrame('event: nada')).toBeUndefined()
  })
})
