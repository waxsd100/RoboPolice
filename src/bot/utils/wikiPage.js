// Reads one page of a Seesaa / memo.wiki wiki: its title, the body split at its headings, the
// images in each part, and the links to other pages of the same wiki.
const { decodeEntities } = require('./urlFetcher')

const MAX_SECTION = 1500

function toText (html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

// The page's own content: from its first user-area to its comments or the page footer, whichever
// comes first (the menus come after).
function bodyOf (html) {
  const at = html.indexOf('class="user-area"')
  if (at === -1) return ''
  const start = html.indexOf('>', at) + 1
  const ends = ['id="comment-box"', 'id="page-footer"'].map(m => html.indexOf(m, start)).filter(i => i !== -1)
  return ends.length ? html.slice(start, html.lastIndexOf('<', Math.min(...ends))) : html.slice(start)
}

// Splits a long text into pieces of at most MAX_SECTION characters, at line ends where it can.
function pieces (text) {
  const out = []
  let rest = text
  while (rest.length > MAX_SECTION) {
    const cut = rest.lastIndexOf('\n', MAX_SECTION)
    const at = cut > MAX_SECTION / 2 ? cut : MAX_SECTION
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

// { title, sections: [{ heading, text, images }], links } for the page at `pageUrl`.
function parseWikiPage (html, pageUrl) {
  const base = new URL(pageUrl)
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s*-\s*[^-]*$/, '').trim()
  const body = bodyOf(html)

  // Headings with an id (content_1, content_1_2) start the parts that can be edited on their own.
  const marks = [...body.matchAll(/<h([2-5])[^>]*id="content_[\d_]+"[^>]*>([\s\S]*?)<\/h\1>/gi)]
  const parts = []
  let last = 0
  let heading = title
  for (const m of marks) {
    parts.push({ heading, html: body.slice(last, m.index) })
    heading = toText(m[2].replace(/<a[^>]*title="部分編集"[\s\S]*?<\/a>/gi, '')) || title
    last = m.index + m[0].length
  }
  parts.push({ heading, html: body.slice(last) })

  const sections = []
  for (const part of parts) {
    // The wiki's own links (edit, attachments, categories) follow the last part.
    const text = toText(part.html).split('\nこのページを編集する')[0].trim()
    if (!text) continue
    const images = [...part.html.matchAll(/<img[^>]+src="(https:\/\/image\d+\.seesaawiki\.jp\/[^"]+)"/gi)].map(m => m[1])
    for (const piece of pieces(text)) sections.push({ heading: part.heading, text: piece, images })
  }

  const links = new Set()
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    let url
    try {
      url = new URL(decodeEntities(m[1]), base)
    } catch (_) {
      continue
    }
    // Only the wiki's pages (/d/…): robots.txt keeps crawlers out of the rest.
    if (url.host === base.host && url.pathname.startsWith('/d/') && !/\/d\/MenuBar/i.test(url.pathname)) {
      url.search = ''
      url.hash = ''
      links.add(url.toString())
    }
  }
  return { title, sections, links: [...links] }
}

module.exports = { parseWikiPage, MAX_SECTION }
