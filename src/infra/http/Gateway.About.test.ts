import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gatewayAbout } from './Gateway.About'
import { OPENAPI_DOCUMENT } from './Openapi.Schema'

describe('gatewayAbout', () => {
  const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version

  it('a versão é a do package.json; sem o build informado, ele não aparece', () => {
    assert.deepStrictEqual(gatewayAbout({}), { name: 'Agents Gateway', version })
    assert.deepStrictEqual(gatewayAbout({ GATEWAY_BUILD: '  ' }), { name: 'Agents Gateway', version })
  })

  it('⚖️ a versão sobe a cada build, num lugar só: o OpenAPI segue o package.json', () => {
    assert.strictEqual(OPENAPI_DOCUMENT.info.version, version)
    assert.match(version, /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/)
  })

  it('do build do instalador (`<versão>+<commit>`) fica só o commit; sem o `+`, o valor inteiro', () => {
    assert.strictEqual(gatewayAbout({ GATEWAY_BUILD: '1.0.0-alpha+5bc892d' }).build, '5bc892d')
    assert.strictEqual(gatewayAbout({ GATEWAY_BUILD: ' 5bc892d ' }).build, '5bc892d')
  })
})
