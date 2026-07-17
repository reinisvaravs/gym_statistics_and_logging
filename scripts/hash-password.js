// Generate a bcrypt hash for AUTH_PASSWORD_HASH.
//   node scripts/hash-password.js "your password"
import bcrypt from 'bcryptjs';

const pw = process.argv[2];
if (!pw) { console.error('Usage: node scripts/hash-password.js "your password"'); process.exit(1); }
console.log(bcrypt.hashSync(pw, 12));
