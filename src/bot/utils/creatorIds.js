// CREATOR_IDS holds one or more Discord user IDs, comma-separated, treated as the bot's own
// developers. Parsed once into an array so every check below is an exact membership test.
//
// Previously this was checked inconsistently: some call sites compared the whole env string with
// `===` (so only ever matched when exactly one ID was configured), and one used
// `process.env.CREATOR_IDS.includes(userID)` directly on the raw string - a SUBSTRING test, not a
// list-membership test. A user whose own ID happened to be a substring of the configured value
// (for example, contained within one of several comma-joined IDs) would incorrectly pass as a
// creator, unlocking creator-only commands such as /eval. Centralizing the parsing here removes
// that whole bug class.
//
// A creator bypasses every permission check a member's own permissions could pass: prefix
// commands, the permissions slash commands ask of the user (userPerms), Manage Events for an event
// asked for by mention, and the permission to post in a forum. Not what the bot itself needs.
function creatorIDs () {
  return (process.env.CREATOR_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
}

function isCreator (userID) {
  return !!userID && creatorIDs().includes(userID)
}

module.exports = { creatorIDs, isCreator }
