const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isCreator, creatorIDs } = require('../../src/bot/utils/creatorIds')

test('CREATOR_IDS is a list of exact IDs, read when asked', () => {
  const saved = process.env.CREATOR_IDS
  try {
    process.env.CREATOR_IDS = ' 111, 222 ,'
    assert.deepEqual(creatorIDs(), ['111', '222'])
    assert.equal(isCreator('111'), true)
    assert.equal(isCreator('222'), true)
    assert.equal(isCreator('11'), false, 'no substring match')
    assert.equal(isCreator(undefined), false)
    delete process.env.CREATOR_IDS
    assert.equal(isCreator('111'), false)
  } finally {
    if (saved === undefined) delete process.env.CREATOR_IDS
    else process.env.CREATOR_IDS = saved
  }
})
