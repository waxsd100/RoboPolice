#!/usr/bin/env node
// Scans staged git changes (or all tracked files with --all) for accidental commits of
// secret files (.env, .tfstate, private keys, service account JSONs) and credential values
// (Discord tokens/webhooks, Google/Gemini API keys, GitHub/HF/OpenAI/AWS tokens, private keys).
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ALLOW_COMMENT = /pragma:\s*allowlist\s+secret|gitleaks:\s*allow|nosecret/i

const FORBIDDEN_FILE_RULES = [
  {
    id: 'dotenv-file',
    description: 'Environment file (.env)',
    test: file => {
      const base = path.basename(file)
      return /^\.env(?:\..+)?$/.test(base) && !/^\.env\.(?:example|sample|template|test)$/i.test(base)
    }
  },
  {
    id: 'terraform-state-or-vars',
    description: 'Terraform state or tfvars file',
    test: file => {
      const base = path.basename(file)
      return /\.tfstate(?:\..+)?$/i.test(base) || (/^(?:terraform\.tfvars|.*\.auto\.tfvars)(?:\.json)?$/i.test(base) && !/\.example$/i.test(base))
    }
  },
  {
    id: 'private-key-or-credential-file',
    description: 'Private key or service account credential file',
    test: file => {
      const base = path.basename(file)
      return /\.(?:pem|key|p12|pfx)$/i.test(base) ||
        /^(?:id_rsa|id_ed25519|id_ecdsa|robopolice-key\.json|.*service-account.*\.json|.*credentials.*\.json)$/i.test(base)
    }
  }
]

const PLACEHOLDER_VALUE = /^(?:your[_-]?.*|get one.*|error logging.*|postgres(?:password|username)?|localhost|127\.0\.0\.1|default|true|false|null|undefined|none|changeme|example.*|placeholder.*|xxx+|dummy.*|fake.*|mock.*|test(?:[-_].*)?|gem-key|gw-token|yt-key|steam-key|twitch-secret|\$\{.*\}|<.*>)$/i

const SECRET_RULES = [
  {
    id: 'private-key-block',
    description: 'PEM / OpenSSH private key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/
  },
  {
    id: 'gcp-service-account-json',
    description: 'Google Cloud service account private_key JSON field',
    regex: /"private_key"\s*:\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----/
  },
  {
    id: 'google-api-key',
    description: 'Google / Gemini / YouTube API key (AIza...)',
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
    validateMatch: match => !/1234567890abcdefghijklmnopqrstuv/i.test(match[0])
  },
  {
    id: 'discord-bot-token',
    description: 'Discord Bot Token',
    regex: /\b[MN][A-Za-z\d]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}\b/
  },
  {
    id: 'discord-webhook-url',
    description: 'Discord Webhook URL',
    regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{60,}/
  },
  {
    id: 'github-token',
    description: 'GitHub Personal Access Token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,})\b/
  },
  {
    id: 'huggingface-token',
    description: 'Hugging Face Access Token (hf_...)',
    regex: /\bhf_[A-Za-z0-9]{32,}\b/
  },
  {
    id: 'openai-or-anthropic-key',
    description: 'OpenAI / Anthropic API Key (sk-...)',
    regex: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{32,}\b/
  },
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
  },
  {
    id: 'slack-token',
    description: 'Slack Token (xox...)',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/
  },
  {
    id: 'database-or-redis-url-with-password',
    description: 'Database / Redis URI with embedded password',
    regex: /\b(?:postgres(?:ql)?|redis(?:s)?):\/\/[^:\s'"`]+:([^@\s'"`]{12,})@(?!localhost\b|127\.0\.0\.1\b|0\.0\.0\.0\b|host\b|example\b)/i,
    validateMatch: match => !PLACEHOLDER_VALUE.test(match[1] || '')
  },
  {
    id: 'env-secret-assignment',
    description: 'Hardcoded secret value assigned to sensitive environment variable',
    regex: /^\s*(?:export\s+)?(BOT_TOKEN|GEMINI_API_KEY|CLOUDFLARE_AI_GATEWAY_TOKEN|GCP_SERVICE_ACCOUNT_KEY|STEAM_API_KEY|TWITCH_CLIENT_SECRET|YOUTUBE_API_KEY|YOUTUBE_WEBSUB_SECRET|REDIS_PASSWORD|PGPASSWORD|AES_KEY)\s*=\s*['"]?([^\s'"#]+)['"]?/,
    validateMatch: match => {
      const val = String(match[2] || '').trim()
      if (val.length < 16) return false
      if (PLACEHOLDER_VALUE.test(val)) return false
      if (/^process\.env\b|^os\.environ\b|^var\.|^local\./.test(val)) return false
      return true
    }
  }
]

function maskSecret (text) {
  const s = String(text || '').trim()
  if (s.length <= 12) return '***'
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}

function checkFilePath (filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  for (const rule of FORBIDDEN_FILE_RULES) {
    if (rule.test(normalized)) {
      return {
        file: normalized,
        line: 0,
        ruleId: rule.id,
        description: rule.description,
        snippet: normalized
      }
    }
  }
  return null
}

function scanLine (line, { file = '', lineNumber = 1 } = {}) {
  if (!line || ALLOW_COMMENT.test(line)) return []
  const findings = []
  for (const rule of SECRET_RULES) {
    const match = line.match(rule.regex)
    if (!match) continue
    if (typeof rule.validateMatch === 'function' && !rule.validateMatch(match, line, file)) continue
    findings.push({
      file,
      line: lineNumber,
      ruleId: rule.id,
      description: rule.description,
      snippet: maskSecret(match[0])
    })
  }
  return findings
}

function scanText (content, { file = '' } = {}) {
  const findings = []
  const lines = String(content || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    findings.push(...scanLine(lines[i], { file, lineNumber: i + 1 }))
  }
  return findings
}

function parseUnifiedDiffAddedLines (diffText) {
  const entries = []
  let currentFile = null
  let currentLine = 0
  for (const rawLine of String(diffText || '').split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice(6).trim()
      continue
    }
    if (rawLine.startsWith('+++ /dev/null')) {
      currentFile = null
      continue
    }
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      currentLine = Number(hunk[1])
      continue
    }
    if (!currentFile) continue
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      entries.push({ file: currentFile, lineNumber: currentLine, text: rawLine.slice(1) })
      currentLine++
    } else if (!rawLine.startsWith('-') && !rawLine.startsWith('\\')) {
      currentLine++
    }
  }
  return entries
}

function scanStaged ({ cwd = process.cwd() } = {}) {
  const findings = []
  const namesOut = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd,
    encoding: 'utf8'
  })
  const stagedFiles = namesOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  for (const file of stagedFiles) {
    const pathFinding = checkFilePath(file)
    if (pathFinding) findings.push(pathFinding)
  }
  if (!stagedFiles.length) return findings
  const diffOut = execFileSync('git', ['diff', '--cached', '-U0', '--diff-filter=ACMR'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  for (const added of parseUnifiedDiffAddedLines(diffOut)) {
    findings.push(...scanLine(added.text, { file: added.file, lineNumber: added.lineNumber }))
  }
  return findings
}

function scanAllTracked ({ cwd = process.cwd() } = {}) {
  const findings = []
  const filesOut = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const files = filesOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  for (const file of files) {
    const pathFinding = checkFilePath(file)
    if (pathFinding) findings.push(pathFinding)
    const full = path.join(cwd, file)
    let stat
    try { stat = fs.statSync(full) } catch (_) { continue }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
    let content
    try { content = fs.readFileSync(full, 'utf8') } catch (_) { continue }
    if (content.includes('\0')) continue
    findings.push(...scanText(content, { file }))
  }
  return findings
}

function main (argv = process.argv.slice(2)) {
  const all = argv.includes('--all')
  const findings = all ? scanAllTracked() : scanStaged()
  if (!findings.length) return 0
  console.error('\n[SECRET CHECK FAILED] 機密情報の可能性があるファイルまたは文字列が検出されました:')
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file
    console.error(`  - ${loc} [${f.ruleId}] ${f.description} (${f.snippet})`)
  }
  console.error('\nコミットを中断しました。機密情報を削除するか、誤検知の場合は該当行末に `# pragma: allowlist secret` を付与してください。')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  checkFilePath,
  scanLine,
  scanText,
  parseUnifiedDiffAddedLines,
  scanStaged,
  scanAllTracked,
  main
}
