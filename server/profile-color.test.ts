/**
 * The color each person picks for their name: anyone may pick one for
 * themselves, one person per color, first come first served.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';

async function body<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe.skipIf(!TEST_DB)('profile colors', () => {
  let alice: string;
  let bob: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await freshDatabase();
    aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
  });

  const pick = (cookie: string, color: unknown, headers?: Record<string, string>) =>
    api('/api/team/color', { cookie, body: { color }, headers });
  const colors = async (cookie: string) => Object.fromEntries(
    (await body<{ people: { id: string; color?: string }[] }>(await api('/api/team', { cookie }))).people
      .map((p) => [p.id, p.color ?? null]),
  );

  it('lets anyone pick a color, and shows it to the whole team', async () => {
    expect((await pick(bob, 'teal')).status).toBe(200);
    expect(await colors(alice)).toEqual({ [aliceId]: null, [bobId]: 'teal' });
  });

  it('gives each color to whoever picked it first', async () => {
    await pick(bob, 'teal');
    const r = await pick(alice, 'teal');
    expect(r.status).toBe(409);
    expect((await body(r)).error).toBe('Bob already has that color');
    expect(await colors(alice)).toEqual({ [aliceId]: null, [bobId]: 'teal' });
  });

  it('settles two people picking the same color at once', async () => {
    const results = await Promise.all([pick(alice, 'red'), pick(bob, 'red')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(Object.values(await colors(alice)).filter((c) => c === 'red')).toHaveLength(1);
  });

  it('frees the old color when someone changes theirs, or gives it up', async () => {
    await pick(bob, 'teal');
    await pick(bob, 'blue');
    expect((await pick(alice, 'teal')).status).toBe(200);
    await pick(bob, null);
    expect((await pick(alice, 'blue')).status).toBe(200);
    expect(await colors(alice)).toEqual({ [aliceId]: 'blue', [bobId]: null });
  });

  it('keeps picking the color you already have harmless', async () => {
    await pick(bob, 'teal');
    expect((await pick(bob, 'teal')).status).toBe(200);
  });

  it('frees the color of someone an admin deletes', async () => {
    await pick(bob, 'teal');
    await api('/api/team/delete', { cookie: alice, body: { userId: bobId } });
    expect((await pick(alice, 'teal')).status).toBe(200);
  });

  it('takes only the colors offered, only for yourself, signed in, and not from another site', async () => {
    expect((await pick(bob, '#ff0000')).status).toBe(400);
    expect((await pick(bob, 'red; drop table')).status).toBe(400);
    expect((await api('/api/team/color', { body: { color: 'red' } })).status).toBe(401);
    expect((await pick(bob, 'red', { origin: 'https://evil.example' })).status).toBe(403);
    // The body names no one: whoever is signed in is who it is for.
    await api('/api/team/color', { cookie: bob, body: { color: 'green', userId: aliceId } });
    expect(await colors(alice)).toEqual({ [aliceId]: null, [bobId]: 'green' });
  });
});
