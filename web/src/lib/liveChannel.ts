import { useConversationsStore } from '@/stores/conversations'
import { openStream } from '@/lib/api'
import { readSse } from '@/lib/sse'

/**
 * Escuta um fluxo ao vivo (o navegador da conversa, um terminal): pelo canal do stream da caixa de entrada, que já está
 * aberto, e só se isso não der (stream fechado, servidor antigo, acesso negado) pelo endpoint dedicado, como antes.
 * Cada quadro chega como `(tipo, dados)`. Resolve quando o fluxo acaba: no endpoint dedicado, quando a conexão fecha;
 * no canal, só ao abortar (a reconexão do stream religa o canal sozinha).
 */
export async function watchLive(channel: string, path: string, onFrame: (type: string, data: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
  const off = await useConversationsStore().openChannel(channel, (frame) => onFrame(frame.type, frame))
  if (off) {
    if (signal.aborted) return off()
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          off()
          resolve()
        },
        { once: true },
      ),
    )
    return
  }
  if (signal.aborted) return
  const body = await openStream(path, { signal })
  for await (const frame of readSse(body)) onFrame(frame.event ?? '', (frame.data ?? {}) as Record<string, unknown>)
}
