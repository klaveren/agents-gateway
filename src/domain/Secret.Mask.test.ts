import assert from 'node:assert'
import { describe, it } from 'node:test'
import { dumpsClusterSecret, IMaskHit, knownForms, maskDeep, maskText } from './Secret.Mask'

const known = knownForms([
  { value: 'senha-do-mongo-123', label: 'MONGO_PASSWORD' },
  { value: 'mongodb://app:SuperSecreta99@db.interno:27017/x', label: 'MONGO_URL' },
  { value: 'curto', label: 'ignorado' },
])

describe('Secret.Mask (a máscara de segredos)', () => {
  it('⛔ valor conhecido: ele, o base64 dele e a senha de dentro de uma URI; curto demais não entra', () => {
    const hits: IMaskHit[] = []
    const out = maskText(`a senha é senha-do-mongo-123, em b64 ${Buffer.from('senha-do-mongo-123').toString('base64')}, e a url usa SuperSecreta99; curto fica`, known, {
      onHit: (hit) => hits.push(hit),
    })
    assert.ok(!out.includes('senha-do-mongo-123') && !out.includes('SuperSecreta99'))
    assert.match(out, /\[segredo:MONGO_PASSWORD\].*\[segredo:MONGO_PASSWORD\].*\[segredo:MONGO_URL\]; curto fica/)
    assert.ok(
      hits.every((hit) => !JSON.stringify(hit).includes('senha')),
      'o acerto guarda só metadado',
    )
  })

  it('forma: nome que diz segredo com valor opaco, em JSON, YAML e .env; HOST, PORT, URL, ID ficam', () => {
    const text = [
      '{"apiKey":"Zx81kLmnQ2pRt5vWy7","clientId":"Zx81kLmnQ2pRt5vWy7","host":"Zx81kLmnQ2pRt5vWy7"}',
      'DB_PASSWORD=Zx81kLmnQ2pRt5vWy7a',
      'export STRIPE_TOKEN="Zx81kLmnQ2pRt5vWy7b"',
      '  auth_token: Zx81kLmnQ2pRt5vWy7c',
      'DB_HOST=Zx81kLmnQ2pRt5vWy7d',
      'SESSION_TIMEOUT=3600',
      'APP_NAME=logiccus-api-servidor-principal',
    ].join('\n')
    const out = maskText(text, [])
    assert.match(out, /"apiKey": "\[segredo:apiKey\]"/)
    assert.match(out, /"clientId":"Zx81kLmnQ2pRt5vWy7"/)
    assert.match(out, /"host":"Zx81kLmnQ2pRt5vWy7"/)
    assert.match(out, /DB_PASSWORD=\[segredo:DB_PASSWORD\]/)
    assert.match(out, /export STRIPE_TOKEN=\[segredo:STRIPE_TOKEN\]/)
    assert.match(out, /auth_token: \[segredo:auth_token\]/)
    assert.match(out, /DB_HOST=Zx81kLmnQ2pRt5vWy7d/)
    assert.match(out, /SESSION_TIMEOUT=3600/)
    assert.match(out, /APP_NAME=logiccus-api-servidor-principal/)
    assert.match(maskText('MEU_CAMPO=Zx81kLmnQ2pRt5vWy7e', [], { extraSecretNames: ['MEU_CAMPO'] }), /\[segredo:MEU_CAMPO\]/)
    assert.match(maskText('DB_PASSWORD_HINT=Zx81kLmnQ2pRt5vWy7f', [], { extraSafeNames: ['_HINT'] }), /Zx81kLmnQ2pRt5vWy7f/)
  })

  it('formato de token conhecido, venha de onde vier; e o JSON estruturado de um MCP', () => {
    const out = maskText(
      `ghp_${'a'.repeat(36)} sk-ant-${'b'.repeat(30)} AKIAABCDEFGHIJKLMNOP ya29.${'c'.repeat(30)} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWZha2U\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----`,
      [],
    )
    for (const label of ['token do GitHub', 'chave de API', 'chave da AWS', 'token do Google', 'JWT', 'chave privada']) assert.ok(out.includes(`[segredo:${label}]`), label)
    assert.ok(!/AAAA|ghp_|AKIA/.test(out))
    assert.deepStrictEqual(maskDeep({ data: { password: 'Zx81kLmnQ2pRt5vWy7', host: 'Zx81kLmnQ2pRt5vWy7', note: 'senha-do-mongo-123' } }, known), {
      data: { password: '[segredo:password]', host: 'Zx81kLmnQ2pRt5vWy7', note: '[segredo:MONGO_PASSWORD]' },
    })
  })

  it('⛔ o comando que despeja Secret do Kubernetes; o describe passa', () => {
    for (const command of [
      'kubectl get secret app -o json',
      'kubectl -n x get secrets -o yaml',
      "kubectl get secret app -o jsonpath='{.data.token}'",
      'ssh srv "kubectl get secret a --output=json"',
    ])
      assert.ok(dumpsClusterSecret(command), command)
    for (const command of ['kubectl describe secret app', 'kubectl get secrets', 'kubectl get pods -o json']) assert.ok(!dumpsClusterSecret(command), command)
  })
})
