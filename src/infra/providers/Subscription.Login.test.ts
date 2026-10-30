import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { inTerminal, onPath, SubscriptionLogins } from './Subscription.Client'

/** Um `spawn` falso: o "terminal" escreve os pedaços dados e sai com `code`. */
function fakeSpawn(chunks: string[], code: number | null = 0) {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null as number | null,
      pid: undefined,
      kill: () => true,
    })
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.write(chunk)
      // `null` = o processo NÃO sai sozinho (o `claude setup-token` real espera um Enter depois do token).
      if (code !== null)
        setImmediate(() => {
          child.exitCode = code
          child.emit('close', code)
        })
    })
    return child
  }) as never
}

/**
 * Espera a condição valer (até 2 s). A tela (xterm) processa a escrita numa fila com timers: um prazo fixo curto passava
 * sozinho e falhava com a suíte inteira rodando em paralelo.
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

const ESC = '\u001b'
const BEL = '\u0007'
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz'
// O formato que o CLI 2.1.309 imprime de verdade (`at01`, não `oat01`).
const TOKEN = 'sk-ant-at01-' + 'A'.repeat(90)

describe('login do Claude pela tela (claude setup-token)', () => {
  it('⛔ pega o link do hiperlink de terminal e o token partido em dois pedaços; o token vai ao cofre e nunca à tela', async () => {
    const saved: string[] = []
    const logins = new SubscriptionLogins(
      fakeSpawn([
        `${ESC}[1mBrowser didn't open?${ESC}[0m ${ESC}]8;id=1;${URL}${BEL}${URL.slice(0, 60)}${ESC}]8;;${BEL}\r\nPaste code here if prompted>`,
        `\r\n${TOKEN.slice(0, 40)}`,
        `${TOKEN.slice(40)}\r\n`,
      ]),
    )
    const view = await logins.start(EProvider.CLAUDE_SUB, { onToken: (token) => saved.push(token) })

    assert.strictEqual(view.url, URL)
    assert.strictEqual(view.needsCode, true)
    await until(() => logins.view(EProvider.CLAUDE_SUB).state !== 'waiting')
    assert.deepStrictEqual(saved, [TOKEN])
    const after = logins.view(EProvider.CLAUDE_SUB)
    assert.strictEqual(after.state, 'done')
    assert.ok(!JSON.stringify(after).includes('sk-ant-'))
  })

  it('sem token na saída, falha — e a mensagem de erro não carrega token nenhum', async () => {
    const logins = new SubscriptionLogins(fakeSpawn([`${ESC}]8;;${URL}${BEL}x`, 'OAuth error: invalid code\r\n'], 1))
    await logins.start(EProvider.CLAUDE_SUB, { onToken: () => assert.fail('não devia gravar') })
    await until(() => logins.view(EProvider.CLAUDE_SUB).state !== 'waiting')
    const view = logins.view(EProvider.CLAUDE_SUB)
    assert.strictEqual(view.state, 'failed')
    assert.match(view.message ?? '', /invalid code/)
  })
})

describe('login do Claude: o processo não sai sozinho', () => {
  it('⛔ o token aparecendo já conecta — sem esperar o processo terminar', async () => {
    const saved: string[] = []
    const logins = new SubscriptionLogins(fakeSpawn([`${ESC}]8;;${URL}${BEL}x`, `\r\n${TOKEN}\r\nPress Enter to continue`], null))
    await logins.start(EProvider.CLAUDE_SUB, { onToken: (token) => saved.push(token) })
    await until(() => logins.view(EProvider.CLAUDE_SUB).state !== 'waiting')
    assert.deepStrictEqual(saved, [TOKEN])
    assert.strictEqual(logins.view(EProvider.CLAUDE_SUB).state, 'done')
  })

  it('código recusado vira "falhou" com o motivo do CLI, em vez de "aguardando" para sempre', async () => {
    const logins = new SubscriptionLogins(
      fakeSpawn([`${ESC}]8;;${URL}${BEL}x`, '\r\nOAuth error: Invalid code. Please make sure the full code was copied\r\nPress Enter to retry.'], null),
    )
    await logins.start(EProvider.CLAUDE_SUB)
    await until(() => logins.view(EProvider.CLAUDE_SUB).state !== 'waiting')
    const view = logins.view(EProvider.CLAUDE_SUB)
    assert.strictEqual(view.state, 'failed')
    assert.match(view.message ?? '', /Invalid code/)
  })
})

describe('a saída é lida na tela renderizada', () => {
  it('⛔ o token desenhado com movimento de cursor sai inteiro (arrancar os códigos perdia o "o" de `oat01`)', async () => {
    const saved: string[] = []
    // O CLI escreve a linha, volta o cursor e redesenha por cima — como o Ink faz.
    const logins = new SubscriptionLogins(fakeSpawn([`${ESC}]8;;${URL}${BEL}x\r\n`, `sk-ant-o${ESC}[1D${ESC}[1C`, `at01-${'B'.repeat(90)}\r\n`], null))
    await logins.start(EProvider.CLAUDE_SUB, { onToken: (token) => saved.push(token) })
    await until(() => saved.length > 0)
    assert.deepStrictEqual(saved, [`sk-ant-oat01-${'B'.repeat(90)}`])
  })
})

describe('login do Antigravity pela tela', () => {
  it('⛔ o link maior que as 400 colunas sai inteiro, e só depois de terminado (cortado, o Google dava `invalid_request`)', async () => {
    const google = `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&scope=${'https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+'.repeat(10)}openid&state=fim`
    const previous = process.env.ANTIGRAVITY_BIN
    process.env.ANTIGRAVITY_BIN = '/bin/sh'
    try {
      const logins = new SubscriptionLogins(
        fakeSpawn(
          [
            'Authentication required. Please visit the URL to log in:\r\n  ',
            google.slice(0, 380),
            `${google.slice(380)}\r\n\r\nOr, paste the authorization code here and press Enter:`,
          ],
          null,
        ),
      )
      const view = await logins.start(EProvider.ANTIGRAVITY)
      assert.ok(google.length > 400)
      assert.strictEqual(view.url, google)
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_BIN
      else process.env.ANTIGRAVITY_BIN = previous
    }
  })
})

describe('pseudo-terminal e binário', () => {
  it('macOS e Linux têm cada um o seu `script`, sempre largo (o link e o token não quebram de linha)', () => {
    const mac = inTerminal(['/x/claude', 'setup-token'], 'darwin')
    assert.strictEqual(mac.command, '/bin/sh')
    assert.match(mac.args.join(' '), /cat \| script -q \/dev\/null/)
    assert.match(mac.args.at(-1) ?? '', /^stty cols 400 rows 50 2>\/dev\/null; exec '\/x\/claude' 'setup-token'$/)

    const linux = inTerminal(['/x/claude', 'setup-token'], 'linux')
    assert.deepStrictEqual([linux.command, linux.args[0], linux.args.at(-1)], ['script', '-qfec', '/dev/null'])
  })

  it('Antigravity ausente: a tela recebe "missing" e as instruções, não um erro de processo', async () => {
    const previous = process.env.ANTIGRAVITY_BIN
    process.env.ANTIGRAVITY_BIN = '/nao/existe/agy'
    try {
      const view = await new SubscriptionLogins(fakeSpawn([])).start(EProvider.ANTIGRAVITY)
      assert.deepStrictEqual([view.state, view.missing], ['failed', true])
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_BIN
      else process.env.ANTIGRAVITY_BIN = previous
    }
    assert.ok(onPath('sh'))
    assert.ok(!onPath('comando-que-nao-existe-xyz'))
  })
})
