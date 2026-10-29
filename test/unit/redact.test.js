const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { redact } = require('../../src/bot/utils/redact')

// Token-shaped strings are assembled at runtime so the source never contains one: GitHub push
// protection rejects commits with anything that looks like a real Discord bot token.
const fakeDiscordToken = (id) => [Buffer.from(id).toString('base64'), 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123'].join('.')

describe('redact', () => {
  const env = {
    BOT_TOKEN: fakeDiscordToken('123456789012345678'),
    AES_KEY: 'super-secret-aes',
    PGPASSWORD: 'pg-pass-123',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'cf-gateway-token-xyz',
    CLOUDFLARE_ACCOUNT_ID: 'abc123accountid',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
    GLOBAL_BOT_PREFIX: '%',
    PGHOST: 'localhost',
    MESSAGE_HISTORY_DAYS: '30',
    SHORT_KEY: 'abc'
  }

  test('masks the values of secret-looking environment variables', () => {
    const text = `token=${env.BOT_TOKEN} aes ${env.AES_KEY} pg ${env.PGPASSWORD} gw ${env.CLOUDFLARE_AI_GATEWAY_TOKEN}`
    const out = redact(text, env)
    for (const name of ['BOT_TOKEN', 'AES_KEY', 'PGPASSWORD', 'CLOUDFLARE_AI_GATEWAY_TOKEN']) {
      assert.doesNotMatch(out, new RegExp(env[name].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name)
    }
    assert.match(out, /\[REDACTED:AES_KEY\]/)
  })

  test('masks the account ID inside the gateway URL', () => {
    const out = redact(`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/gw/google-ai-studio`, env)
    assert.equal(out, 'https://gateway.ai.cloudflare.com/v1/[REDACTED:CLOUDFLARE_ACCOUNT_ID]/gw/google-ai-studio')
  })

  test('leaves non-secret settings and very short values alone', () => {
    assert.equal(redact('prefix % host localhost days 30 abc', env), 'prefix % host localhost days 30 abc')
  })

  test('masks Discord webhook URLs and bot tokens that are not in the environment', () => {
    const out = redact(`hook https://canary.discord.com/api/v10/webhooks/123456/AbC-dEf_123 tok ${fakeDiscordToken('999999999999999999')}`, {})
    assert.equal(out, 'hook [REDACTED:webhook] tok [REDACTED:discord-token]')
  })

  test('masks Google API keys echoed back by an API', () => {
    assert.equal(redact('API key not valid: AIzaSyA1234567890abcdefghijklmnopqrstuv', {}), 'API key not valid: [REDACTED:google-api-key]')
  })

  test('masks bearer tokens, URL credentials and secret-named fields', () => {
    assert.doesNotMatch(redact('Authorization: Bearer abc.def-ghi', {}), /abc\.def-ghi/)
    assert.equal(redact('sent Bearer abc.def-ghi', {}), 'sent Bearer [REDACTED]')
    assert.equal(redact('redis://default:hunter2@redis.internal:6379', {}), 'redis://[REDACTED]@redis.internal:6379')
    assert.equal(redact('{"api_key":"k-123","password": "p@ss","name":"ok"}', {}), '{"api_key":"[REDACTED]","password": "[REDACTED]","name":"ok"}')
    assert.equal(redact('https://x.test/cb?token=abc&page=2', {}), 'https://x.test/cb?token=[REDACTED]&page=2')
  })

  test('keeps the parts of a real gateway error that help debugging', () => {
    const body = 'Gemini request failed: HTTP 400 {"error":[{"code":2040,"message":"Provider \'google-ai-studio\' has no BYOK credential named \'default\'. Configured aliases: \'Gemini_API_Key\'"}]}'
    assert.equal(redact(body, env), body)
  })
})
