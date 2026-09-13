// STAFF_ROLE_ID names one role in the server. A member holding that role, or any role positioned
// at or above it in the server's role hierarchy (Settings > Roles, top = highest), is treated as
// staff and bypasses the same checks a server owner already bypasses: a single required permission
// (`perm`), a list of required permissions (`perms`/`userPerms`), or an `admin`-type command.
//
// This does NOT apply to creator-only commands (bot developer tooling like /eval - see
// src/bot/utils/creatorIds.js) and does NOT affect `botPerms` (what the bot itself needs in the
// channel - a user's role can't grant the bot more Discord permissions).
//
// Unset, or set to a role ID that doesn't exist in this guild, means no bypass: fail closed rather
// than silently granting everyone (empty position check) or nobody being able to tell why.
function hasStaffAccess (memberRoleIDs, guild) {
  const roleID = process.env.STAFF_ROLE_ID
  if (!roleID || !guild || !memberRoleIDs) return false
  const staffRole = guild.roles.get(roleID)
  if (!staffRole) return false
  return memberRoleIDs.some(id => {
    const role = guild.roles.get(id)
    return !!role && role.position >= staffRole.position
  })
}

module.exports = { hasStaffAccess }
