import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gatewayAbout } from './Gateway.About'

describe('gatewayAbout', () => {
  const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version

  it('a versão é a do package.json; sem o build informado, ele não aparece', () => {
    assert.deepStrictEqual(gatewayAbout({}), { name: 'Agents Gateway', version })
    assert.deepStrictEqual(gatewayAbout({ GATEWAY_BUILD: '  ' }), { name: 'Agents Gateway', version })
  })

  it('do build do instalador (`<versão>+<commit>`) fica só o commit; sem o `+`, o valor inteiro', () => {
    assert.strictEqual(gatewayAbout({ GATEWAY_BUILD: '1.0.0-alpha+5bc892d' }).build, '5bc892d')
    assert.strictEqual(gatewayAbout({ GATEWAY_BUILD: ' 5bc892d ' }).build, '5bc892d')
  })
})
