const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { checkFilePath, scanLine, scanText, parseUnifiedDiffAddedLines } = require('../../src/miscellaneous/checkSecrets')

describe('checkSecrets', () => {
  it('blocks sensitive filenames while allowing example templates', () => {
    assert.ok(checkFilePath('.env'))
    assert.ok(checkFilePath('.env.production'))
    assert.ok(checkFilePath('infra/terraform/terraform.tfvars'))
    assert.ok(checkFilePath('infra/terraform/terraform.tfstate'))
    assert.ok(checkFilePath('robopolice-key.json'))
    assert.ok(checkFilePath('certs/server.pem'))
    assert.equal(checkFilePath('.env.example'), null)
    assert.equal(checkFilePath('infra/terraform/terraform.tfvars.example'), null)
    assert.equal(checkFilePath('src/bot/modules/eventDrafter.js'), null)
  })

  it('detects common API keys, tokens, webhooks, and private keys', () => {
    const fakeGoogleKey = 'AIza' + 'SyD9_0123456789abcdef0123456789abcd'
    assert.equal(scanLine(`const k = "${fakeGoogleKey}"`)[0]?.ruleId, 'google-api-key')

    const fakeDiscordToken = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.G1a2b3.' + 'abcdefghijklmnopqrstuvwxyz0123456789'
    assert.equal(scanLine(`BOT_TOKEN=${fakeDiscordToken}`)[0]?.ruleId, 'discord-bot-token')

    const fakeWebhook = 'https://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(68)
    assert.equal(scanLine(`DISCORD_WEBHOOK_URL=${fakeWebhook}`)[0]?.ruleId, 'discord-webhook-url')

    const fakeGh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    assert.equal(scanLine(`token: ${fakeGh}`)[0]?.ruleId, 'github-token')

    const fakeHf = 'hf_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'
    assert.equal(scanLine(`UNCENSORED_API_KEY=${fakeHf}`)[0]?.ruleId, 'huggingface-token')

    const fakePem = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
    assert.equal(scanLine(fakePem)[0]?.ruleId, 'private-key-block')
  })

  it('allows safe placeholders, test fixtures, and allowlist comments', () => {
    assert.deepEqual(scanLine('BOT_TOKEN=get one from discord developers page'), [])
    assert.deepEqual(scanLine('PGPASSWORD=postgrespassword'), [])
    assert.deepEqual(scanLine('AES_KEY=youraeskey'), [])
    assert.deepEqual(scanLine('GEMINI_API_KEY=gem-key'), [])
    const fakeGoogleKey = 'AIza' + 'SyD9_0123456789abcdef0123456789abcd'
    assert.deepEqual(scanLine(`const k = "${fakeGoogleKey}" // pragma: allowlist secret`), [])
  })

  it('parses added lines with accurate file and line numbers from unified diff', () => {
    const diff = [
      'diff --git a/config.js b/config.js',
      '--- a/config.js',
      '+++ b/config.js',
      '@@ -10,0 +11,2 @@',
      '+const safe = 1',
      '+const key = "AIza' + 'SyD9_0123456789abcdef0123456789abcd"'
    ].join('\n')
    const added = parseUnifiedDiffAddedLines(diff)
    assert.equal(added.length, 2)
    assert.equal(added[1].file, 'config.js')
    assert.equal(added[1].lineNumber, 12)
    const findings = scanText(added[1].text, { file: added[1].file })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].ruleId, 'google-api-key')
  })
})
