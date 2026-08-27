// Mint a password-recovery token for an EXISTING user — the no-email version of
// "forgot password". Email the user the token/link and they set a new password
// via the frontend's /set-password page.
//
//   node scripts/reset-password.mjs <username> [--remote] [--hostname <host>]
//
// With --hostname, a full clickable URL is printed; otherwise just the raw token.

import {
  lookupUserId,
  mintRecoveryToken,
  parseArgs,
  printRecovery,
} from "./recovery.mjs";

const { remote, hostname, positional } = parseArgs(process.argv.slice(2));
const username = positional[0];

if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
  console.error(
    "Usage: node scripts/reset-password.mjs <username> [--remote] [--hostname <host>]\n" +
      "  username must match [A-Za-z0-9._-]{1,64}",
  );
  process.exit(1);
}

let id;
try {
  id = lookupUserId(username, { remote });
} catch (err) {
  console.error("\nFailed to look up user.");
  process.exit(1);
}

if (!id) {
  console.error(`\nNo such user: ${username}`);
  process.exit(1);
}

const token = await mintRecoveryToken({ userId: id, remote });

console.log(`\nPassword reset for (${remote ? "remote" : "local"}):`);
console.log(`  username: ${username}`);
console.log(`  id:       ${id}`);
printRecovery({ token, hostname });
