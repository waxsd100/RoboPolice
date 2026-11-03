// Reads the objects of the arrays named `arrayKey` out of a JSON response as it streams in, one at a
// time, without holding the whole response: a batch's results can be hundreds of megabytes (20,000
// embeddings of 512 numbers), more than is sensible to read into one string and parse at once.
//
// Only the text of one item is kept at a time; everything else is just scanned. The JSON is
// assumed to be well formed (it is Gemini's); an item that does not parse is skipped.

// Calls onItem(object) for each object directly inside an array whose key is `arrayKey` (or one of
// them, given a list), wherever it is. `chunks` is an async iterable of strings. Resolves to how
// many items were found.
async function forEachArrayItem (chunks, arrayKey, onItem) {
  const keys = new Set([].concat(arrayKey))
  const stack = [] // { type: '{' | '[', target, item }
  let inString = false
  let escape = false
  let expectKey = false
  let readingKey = false
  let key = ''
  let currentKey = null
  let parts = null // the text of the item being read, in pieces
  let itemDepth = -1
  let count = 0

  for await (const chunk of chunks) {
    let from = parts ? 0 : -1
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (inString) {
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') {
          inString = false
          if (readingKey) {
            readingKey = false
            expectKey = false
            currentKey = key
          }
        } else if (readingKey && key.length < 64) key += c
        continue
      }
      if (c === '"') {
        inString = true
        if (expectKey && stack[stack.length - 1]?.type === '{') {
          readingKey = true
          key = ''
        }
      } else if (c === '{') {
        const parent = stack[stack.length - 1]
        if (!parts && parent?.type === '[' && parent.target) {
          parts = []
          from = i
          itemDepth = stack.length
        }
        stack.push({ type: '{' })
        expectKey = true
        currentKey = null
      } else if (c === '[') {
        const parent = stack[stack.length - 1]
        stack.push({ type: '[', target: parent?.type === '{' && keys.has(currentKey) })
        expectKey = false
        currentKey = null
      } else if (c === '}' || c === ']') {
        stack.pop()
        expectKey = false
        if (c === '}' && parts && stack.length === itemDepth) {
          parts.push(chunk.slice(from, i + 1))
          const text = parts.join('')
          parts = null
          from = -1
          itemDepth = -1
          let item
          try { item = JSON.parse(text) } catch (_) { item = null }
          if (item) {
            count++
            await onItem(item)
          }
        }
      } else if (c === ',') {
        if (stack[stack.length - 1]?.type === '{') expectKey = true
        currentKey = null
      }
    }
    if (parts && from >= 0) parts.push(chunk.slice(from))
  }
  return count
}

// A fetch Response's body as text chunks.
async function * textChunks (res) {
  const decoder = new TextDecoder()
  for await (const bytes of res.body) yield decoder.decode(bytes, { stream: true })
  const rest = decoder.decode()
  if (rest) yield rest
}

module.exports = { forEachArrayItem, textChunks }
