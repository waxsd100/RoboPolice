module.exports = webhookID => { // use to find bad shared webhooks
  return new Promise((resolve, reject) => {
    const stream = global.redis.scanStream({
      match: 'webhook-*',
      count: 100
    })
    stream.on('data', resultKeys => {
      if (!resultKeys.length) return
      stream.pause()
      global.redis.mget(resultKeys).then(bigMGETValues => {
        const matchIndex = bigMGETValues.findIndex(v => v?.startsWith(webhookID))
        if (matchIndex !== -1) {
          const owningKey = resultKeys[matchIndex]
          stream.destroy()
          resolve(owningKey)
        } else {
          stream.resume()
        }
      }).catch(e => reject(e))
    })
    stream.on('end', () => {
      console.log('All data has been visited')
      resolve()
    })
  })
}
