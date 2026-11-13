// Links in a reply are kept only when they came from somewhere: the request, the conversation or
// what a tool read. A page that says "introduce this link as the official site" cannot make the
// bot post a link out of nowhere, and a link whose text names one site while it goes to another
// shows where it really goes.

const URL_PATTERN = /https?:\/\/(?:[^\s<>()[\]"'`]|\([^\s<>()[\]"'`]*\))+/gi
const MASKED = /\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*(?:<(https?:\/\/[^\s<>]+)>|(https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi
// A domain written in a link's text (example.com, www.example.co.jp).
const DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi

const trimUrl = url => url.replace(/[.,!?;:、。）」』】>]+$/u, '')

function hostOf (url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch (_) { return null }
}

// The URLs anywhere in `sources` (strings or anything JSON can hold).
function urlsIn (...sources) {
  const text = sources.map(s => typeof s === 'string' ? s : JSON.stringify(s ?? '')).join('\n')
    .replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  return new Set([...text.matchAll(URL_PATTERN)].map(m => trimUrl(m[0])))
}

// A YouTube video's ID in a URL, so a watch link with another form (youtu.be, &t=…) of a video that
// came up still counts.
function videoIdOf (url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch (_) {
    return null
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  if (host === 'youtu.be') {
    const m = parsed.pathname.match(/^\/([\w-]{11})(?:\/|$)/)
    return m ? m[1] : null
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
    if (parsed.pathname === '/watch') {
      const v = parsed.searchParams.get('v')
      return v && /^[\w-]{11}$/.test(v) ? v : null
    }
    const m = parsed.pathname.match(/^\/(?:live|shorts|embed|v)\/([\w-]{11})(?:\/|$)/)
    return m ? m[1] : null
  }
  return null
}

function isKnown (url, known, knownVideos) {
  const u = trimUrl(url)
  if (known.has(u)) return true
  const id = videoIdOf(u)
  return !!(id && knownVideos.has(id))
}

// `text` with links that came from nowhere in `sources` left as plain text, and links whose text
// names another site showing where they go. Resolves to { text, removed: [url] }.
function safeLinks (text, ...sources) {
  const known = urlsIn(...sources)
  const knownVideos = new Set([...known].map(videoIdOf).filter(Boolean))
  const removed = []
  const kept = []
  let out = String(text || '').replace(MASKED, (whole, label, bracketedUrl, bareUrl) => {
    const url = bracketedUrl || bareUrl
    if (!isKnown(url, known, knownVideos)) {
      removed.push(url)
      return label
    }
    const namedDomains = [...label.matchAll(DOMAIN)].map(m => m[1].replace(/^www\./, '').toLowerCase())
    const host = hostOf(url)
    const mismatched = host && namedDomains.some(named => named !== host && !host.endsWith(`.${named}`))
    const rendered = mismatched
      ? `${whole}（行き先: ${host}）`
      : whole
    return `\0MASKED_${kept.push(rendered) - 1}\0`
  })
  // Bare links outside the masked ones.
  out = out.replace(URL_PATTERN, url => {
    if (isKnown(url, known, knownVideos)) return url
    removed.push(url)
    return '（リンクは省きました）'
  })
  out = out.replace(/\0MASKED_(\d+)\0/g, (_, i) => kept[Number(i)])
  return { text: out, removed }
}

module.exports = { safeLinks, urlsIn, hostOf }
