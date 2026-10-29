// Masks secrets in text that is about to be shown in a Discord channel (error logs sent back to
// the requester). Two layers: the actual values of secret-looking environment variables, and
// patterns for secrets that never were in our environment (keys echoed back by an API, URLs with
// credentials).

const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASS$|WEBHOOK|DSN|_URI$|CREDENTIAL|ACCOUNT_ID/i
// Shorter values are too likely to also be ordinary words or numbers in the log.
const MIN_SECRET_LENGTH = 6

const PATTERNS = [
  // Discord webhook URLs carry their own token.
  [/https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/gi, '[REDACTED:webhook]'],
  // Discord bot tokens: base64 user ID . timestamp . HMAC
  [/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, '[REDACTED:discord-token]'],
  // Google API keys
  [/AIza[\w-]{35}/g, '[REDACTED:google-api-key]'],
  // Bearer and basic credentials in headers
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [REDACTED]'],
  // Credentials in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // key=value pairs and JSON fields whose name says they are secret
  [/((?:api[_-]?key|token|secret|password|passwd|authorization|x-goog-api-key|cf-aig-authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1[REDACTED]']
]

function secretEnvValues (env) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    // Longest first, so a value that contains another is masked whole.
    .sort((a, b) => b[1].length - a[1].length)
}

function redact (text, env = process.env) {
  let out = String(text)
  for (const [name, value] of secretEnvValues(env)) {
    out = out.split(value).join(`[REDACTED:${name}]`)
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

module.exports = { redact }
