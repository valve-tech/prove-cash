/**
 * Where a stranger reports a bug or a security hole: our SimpleX contact address.
 *
 * It must stay a contact address. SimpleX writes a reusable address as `/a#` (short form) or
 * `/contact#` (long form). A one-time invitation, `/i#` or `/invitation#`, works for the first
 * person who opens it and then silently reaches nobody. `security.test.ts` holds that line, and
 * checks that `SECURITY.md` and `/.well-known/security.txt` carry this same address.
 */
export const SECURITY_CONTACT = 'https://smp12.simplex.im/a#bU9ltr40p0c5WoAxDzKy1RdSqhcwi3EqQkduz-_EusU'
