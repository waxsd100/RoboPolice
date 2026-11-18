// Which search results are worth passing on: not a fixed count of the closest, but as many as the
// scores say. A fixed count brings in whatever is next when little is close (for one word such as
// 「児童」 the wiki gave characters and bots that had nothing to do with it), and leaves out what is
// as close as the rest when much is.
//
// Of `items`, those at least `min`, within `window` of the best, and before the first drop of
// `cliff` or more from one to the next, best first, at most `limit`. The best is always kept when
// it reaches `min`. score: an item's similarity to the query (cosine, -1..1).
const WINDOW = 0.08
const CLIFF = 0.03

function relevant (items, { score = item => item.score, min = -Infinity, window = WINDOW, cliff = CLIFF, limit = Infinity } = {}) {
  const sorted = [...items].filter(item => Number.isFinite(score(item)) && score(item) >= min).sort((a, b) => score(b) - score(a))
  if (!sorted.length) return []
  const top = score(sorted[0])
  const kept = sorted.filter(item => score(item) >= top - window)
  const drop = kept.findIndex((item, i) => i > 0 && score(kept[i - 1]) - score(item) >= cliff)
  return (drop > 0 ? kept.slice(0, drop) : kept).slice(0, limit)
}

module.exports = { relevant, WINDOW, CLIFF }
