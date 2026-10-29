// Stand-ins for the parts of Eris, Discord and Gemini the event drafting code touches. They record
// what the code did so tests can assert on it.
const http = require('http')

process.env.AES_KEY = process.env.AES_KEY || 'test-aes-key'
global.logger = global.logger || { info () {}, warn () {}, error () {}, debug () {}, startup () {}, fatal () {} }
global.webhook = global.webhook || { generic () {}, warn () {}, error () {}, fatal () {} }

const READ = ['viewChannel', 'readMessageHistory']

function perms (names) {
  return { has: name => names.includes(name), json: Object.fromEntries(names.map(n => [n, true])) }
}

// channels: [{ id, name, type, readers: [userID], posters: [userID], moderators: [userID] }]
function createGuild ({ id = '100', ownerID = '900', channels = [], botPerms = ['manageEvents'] } = {}) {
  const guild = { id, ownerID, roles: new Map(), members: new Map(), channels: new Map() }
  guild.members.set('BOT', { id: 'BOT', permissions: perms(botPerms) })
  for (const c of channels) {
    guild.channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: c.type ?? 0,
      guild,
      permissionsOf: userID => perms([
        ...((c.readers || []).includes(userID) ? READ : []),
        ...((c.posters || []).includes(userID) ? ['viewChannel', 'sendMessages'] : []),
        ...((c.moderators || []).includes(userID) ? ['manageThreads'] : [])
      ])
    })
  }
  return guild
}

function createMember ({ id = '1', permissions = ['manageEvents'], roles = [] } = {}) {
  return { id, roles, permissions: perms(permissions) }
}

// messages: { 'channelID/messageID': { content, author, ... } }
// forums: { channelID: { available_tags, flags, topic } } as GET /channels/:id returns them
function installBot ({ guilds = [], messages = {}, scheduledEvents = [], forums = {} } = {}) {
  const calls = []
  global.bot = {
    user: { id: 'BOT' },
    getChannel (id) {
      for (const g of guilds) if (g.channels.has(id)) return g.channels.get(id)
      return undefined
    },
    async getMessage (channelID, messageID) {
      const m = messages[`${channelID}/${messageID}`]
      if (!m) throw new Error('Unknown Message')
      return { timestamp: 0, embeds: [], attachments: [], author: { id: '2', username: 'alice' }, ...m }
    },
    async getMessages (channelID, { limit }) {
      calls.push({ getMessages: channelID, limit })
      return Object.entries(messages)
        .filter(([key]) => key.startsWith(`${channelID}/`))
        .map(([, m]) => ({ timestamp: 0, embeds: [], attachments: [], author: { id: '2', username: 'alice' }, ...m }))
        .slice(0, limit)
    },
    requestHandler: {
      async request (method, url, auth, body, files) {
        calls.push({ method, url, body, files })
        const forum = url.match(/^\/channels\/(\d+)$/)
        if (method === 'GET' && forum) return { id: forum[1], type: 15, ...forums[forum[1]] }
        if (method === 'GET') return scheduledEvents
        if (url.endsWith('/threads')) return { id: 'THREAD1', ...body }
        return { id: 'EVENT1', ...body }
      }
    }
  }
  return calls
}

function configureGateway () {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'gw'
  process.env.GEMINI_API_KEY = 'gemini-key'
  delete process.env.CLOUDFLARE_AI_GATEWAY_TOKEN
  delete process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  delete process.env.GEMINI_MODEL
}

// A fake Gemini. `turns` is a list of model turns; each is an array of parts, or a function that
// receives the request body and returns parts (to answer based on what the tools returned).
function installGemini (turns) {
  const requests = []
  let i = 0
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, headers: init.headers, body })
    const turn = turns[i++]
    if (turn === undefined) throw new Error(`fake Gemini: no scripted turn ${i}`)
    if (turn instanceof Error) {
      return { ok: false, status: 500, text: async () => turn.message }
    }
    const parts = typeof turn === 'function' ? turn(body) : turn
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) }
  }
  return requests
}

const call = (name, args = {}) => ({ functionCall: { name, args } })
const submit = args => call('submit_event_draft', { found: true, ...args })

// Tool responses the model received in the last request.
function lastToolResponses (body) {
  const last = body.contents[body.contents.length - 1]
  return last.parts.filter(p => p.functionResponse).map(p => p.functionResponse)
}

async function startServer (handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

module.exports = {
  perms, createGuild, createMember, installBot, configureGateway, installGemini, call, submit, lastToolResponses, startServer
}
