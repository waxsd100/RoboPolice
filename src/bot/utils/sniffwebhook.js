module.exports = webhookID => { // use to find bad shared webhooks
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const stream = global.redis.scanStream({
      match: 'webhook-*',
      count: 100
    })

    stream.on('error', err => {
      global.logger?.error?.('Redis scanStream error while sniffing webhook', err)
      finish()
    })

    stream.on('data', resultKeys => {
      if (!resultKeys.length || settled) return
      stream.pause()
      global.redis.mget(resultKeys).then(bigMGETValues => {
        const matchIndex = bigMGETValues.findIndex(v => v?.startsWith(webhookID))
        if (matchIndex !== -1) {
          const owningKey = resultKeys[matchIndex]
          stream.destroy()
          finish(owningKey)
        } else {
          stream.resume()
        }
      }).catch(err => {
        global.logger?.error?.('Redis mget error while sniffing webhook', err)
        stream.destroy()
        finish()
      })
    })

    stream.on('end', () => {
      console.log('All data has been visited')
      finish()
    })
  })
}
