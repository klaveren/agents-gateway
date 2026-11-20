import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Request } from 'express'
import { fromThisMachine } from '@infra/http/Drain.State'
import { cleanEnv, localTerminalEnabled, loginShell } from './Local.Terminal'

const request = (remote: string, headers: Record<string, string> = {}, local = '127.0.0.1') =>
  ({ socket: { remoteAddress: remote, localAddress: local }, headers }) as unknown as Request

describe('Local.Terminal — o terminal do Mac dentro do app', () => {
  it('só abre para a tela na MESMA máquina: loopback sim, rede e proxy não', () => {
    assert.equal(fromThisMachine(request('127.0.0.1', { origin: 'http://localhost:3210', 'sec-fetch-site': 'same-origin' })), true)
    assert.equal(fromThisMachine(request('::ffff:127.0.0.1')), true)
    assert.equal(fromThisMachine(request('::1', {}, '::1')), true)
    assert.equal(fromThisMachine(request('192.168.0.20', {}, '192.168.0.10')), false)
    assert.equal(fromThisMachine(request('10.10.0.9', {}, '10.10.0.4')), false)
    // Atrás de proxy o socket é local, mas o pedido não é.
    assert.equal(fromThisMachine(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), false)
    assert.equal(fromThisMachine(request('127.0.0.1', { forwarded: 'for=203.0.113.7' })), false)
    assert.equal(fromThisMachine(request('127.0.0.1', { 'x-real-ip': '203.0.113.7' })), false)
  })

  it('o ambiente é limpo: nada do processo do gateway', () => {
    const env = cleanEnv(
      { username: 'pessoa', homedir: '/Users/pessoa', shell: '/bin/zsh', uid: 1, gid: 1 },
      {
        SHELL: '/bin/zsh',
        LANG: 'pt_BR.UTF-8',
        ANTHROPIC_API_KEY: 'segredo',
        GATEWAY_DATA: '/dados',
        AUTH_SECRET: 'x',
      },
    )
    assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TERM_PROGRAM', 'USER'])
    assert.equal(env.HOME, '/Users/pessoa')
    assert.equal(env.LANG, 'pt_BR.UTF-8')
    assert.ok(!Object.values(env).includes('segredo'))
  })

  it('o shell é o de login da pessoa (ou um que exista)', () => {
    assert.equal(loginShell({ username: 'p', homedir: '/tmp', shell: '/bin/sh', uid: 1, gid: 1 }, {}), '/bin/sh')
    assert.match(loginShell({ username: 'p', homedir: '/tmp', shell: 'zsh-relativo', uid: 1, gid: 1 }, {}), /^\//)
  })

  it('desliga com GATEWAY_LOCAL_TERMINAL=0', () => {
    assert.equal(localTerminalEnabled({}), true)
    assert.equal(localTerminalEnabled({ GATEWAY_LOCAL_TERMINAL: '0' }), false)
  })
})
