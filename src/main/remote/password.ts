import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { MIN_REMOTE_PASSWORD_LENGTH } from '../../shared/types';

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const COST = 16384;
const FORMAT = 'scrypt';

function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N: cost }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns a problem with a proposed password, or null when it is acceptable. */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_REMOTE_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_REMOTE_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 256) return 'The password must be at most 256 characters.';
  return null;
}

/** `scrypt$<cost>$<salt hex>$<hash hex>`: a random salt each time; the password itself is never stored. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return [FORMAT, String(COST), salt.toString('hex'), key.toString('hex')].join('$');
}

/** Constant-time check of a password against a stored hash. A missing or malformed hash never matches. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false;
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== FORMAT) return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024 || cost > 1 << 20 || (cost & (cost - 1)) !== 0) return false;
  if (!/^[0-9a-f]+$/.test(parts[2]) || !/^[0-9a-f]+$/.test(parts[3])) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt, cost);
  return timingSafeEqual(actual, expected);
}
