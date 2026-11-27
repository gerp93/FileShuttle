import { describe, expect, it } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('never stores the plain password and salts every hash differently', async () => {
    const a = await hashPassword('hunter2hunter2');
    const b = await hashPassword('hunter2hunter2');
    expect(a).not.toContain('hunter2hunter2');
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(a).not.toBe(b);
    expect(await verifyPassword('hunter2hunter2', b)).toBe(true);
  });

  it('never matches a missing or malformed hash', async () => {
    expect(await verifyPassword('whatever1', null)).toBe(false);
    expect(await verifyPassword('whatever1', '')).toBe(false);
    expect(await verifyPassword('whatever1', 'plain-text')).toBe(false);
    expect(await verifyPassword('whatever1', 'scrypt$16384$zz$zz')).toBe(false);
    expect(await verifyPassword('whatever1', 'scrypt$3$00$00')).toBe(false);
  });

  it('requires at least 8 characters', () => {
    expect(validatePassword('short')).not.toBeNull();
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('x'.repeat(300))).not.toBeNull();
  });
});
