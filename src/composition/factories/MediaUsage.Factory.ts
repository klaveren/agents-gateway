import type { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'
import { imageUsageRows } from '@domain/models/ImageUsage.Model'
import { speechUsageRows } from '@domain/models/SpeechUsage.Model'
import { makeImageUsage } from './ImageUsage.Factory'
import { makeSpeechUsage } from './SpeechUsage.Factory'

/**
 * 🎞️ As linhas de uso de mídia (a voz e as imagens) no recorte do pedido: as MESMAS para a tela Uso e para o teto do mês —
 * é o que faz a voz e a imagem contarem nos tokens da pessoa.
 */
export function mediaUsageRowsOf(query: IUsageQuery): IUsageRow[] {
  return [...speechUsageRows(makeSpeechUsage().since(query.since), query), ...imageUsageRows(makeImageUsage().since(query.since), query)]
}
