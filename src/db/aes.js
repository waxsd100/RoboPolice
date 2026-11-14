require('dotenv').config()

const AES = require('aes256')

let cachedKey = null
let cachedCipher = null

function getCipher () {
  const key = process.env.AES_KEY
  if (!key || typeof key !== 'string') return null
  if (key !== cachedKey || !cachedCipher) {
    cachedCipher = AES.createCipher(key)
    cachedKey = key
  }
  return cachedCipher
}

module.exports = {
  encrypt (plaintext) {
    if (plaintext == null) return null
    const cipher = getCipher()
    if (!cipher) return null
    return cipher.encrypt(String(plaintext))
  },
  decrypt (ciphertext) {
    if (ciphertext == null) return null
    const cipher = getCipher()
    if (!cipher) return null
    try {
      return cipher.decrypt(String(ciphertext))
    } catch (_) {
      return null
    }
  }
}
