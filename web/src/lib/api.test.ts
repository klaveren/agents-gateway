import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCsrf } from './api'

function cookies(value: string) {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue(value)
}

afterEach(() => vi.restoreAllMocks())

describe('CSRF da sessão', () => {
  it('dois gateways no mesmo host: vale o cookie da porta desta tela, não o primeiro da lista', () => {
    cookies(`tema=escuro; gw_csrf_3122=do-outro; gw_csrf_${location.port}=desta-porta`)
    expect(readCsrf()).toBe('desta-porta')
  })

  it('atrás de proxy (a porta do nome é a interna): vale o que houver', () => {
    cookies('gw_csrf_9999=unico')
    expect(readCsrf()).toBe('unico')
  })

  it('sem cookie de CSRF: nada', () => {
    cookies('tema=escuro')
    expect(readCsrf()).toBeUndefined()
  })
})
