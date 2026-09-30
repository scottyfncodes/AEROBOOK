/**
 * Chat and aircraft comments against a real Postgres: that people can talk,
 * and that nobody reaches a conversation or comment they are not meant to,
 * whatever ids they put in the address.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';

async function body<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe.skipIf(!TEST_DB)('chat', () => {
  let alice: string;
  let bob: string;
  let carol: string;
  let dave: string;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let daveId: string;

  beforeEach(async () => {
    await freshDatabase();
    aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    carolId = (await createUser('Carol', 'carol@example.com')).id;
    daveId = (await createUser('Dave', 'dave@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
    carol = await signIn('carol@example.com');
    dave = await signIn('dave@example.com');
  });

  const direct = async (cookie: string, userId: string) =>
    body(await api('/api/chat/conversations', { cookie, body: { kind: 'direct', userId } }));
  const send = (cookie: string, id: string, text: string, clientId?: string) =>
    api(`/api/chat/conversations/${id}/messages`, { cookie, body: { body: text, clientId } });
  const history = async (cookie: string, id: string, query = '') =>
    body(await api(`/api/chat/conversations/${id}/messages${query}`, { cookie }));

  describe('one to one', () => {
    it('starts a conversation, sends, and shows the history with sender and time', async () => {
      const convo = await direct(alice, bobId);
      expect(convo.kind).toBe('direct');
      expect(convo.title).toBe('Bob');
      expect(convo.members.map((m: { name: string }) => m.name).sort()).toEqual(['Alice', 'Bob']);

      expect((await send(alice, convo.id, 'Insurance documents updated.')).status).toBe(200);
      expect((await send(bob, convo.id, 'Thanks — looking now.')).status).toBe(200);

      const { messages } = await history(bob, convo.id);
      expect(messages.map((m: { body: string }) => m.body)).toEqual(['Insurance documents updated.', 'Thanks — looking now.']);
      expect(messages[0].senderName).toBe('Alice');
      expect(messages[0].senderId).toBe(aliceId);
      expect(Date.parse(messages[0].createdAt)).not.toBeNaN();
    });

    it('is the same conversation whoever starts it, and however many times', async () => {
      const a = await direct(alice, bobId);
      const b = await direct(bob, aliceId);
      const again = await direct(alice, bobId);
      expect(b.id).toBe(a.id);
      expect(again.id).toBe(a.id);
      const [one, two] = await Promise.all([direct(carol, daveId), direct(dave, carolId)]);
      expect(one.id).toBe(two.id);
    });

    it('refuses a conversation with yourself, someone unknown, or someone whose access is off', async () => {
      expect((await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: aliceId } })).status).toBe(400);
      expect((await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: 'nobody' } })).status).toBe(400);
      await getPool().query('update "user" set banned = true where id = $1', [daveId]);
      expect((await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: daveId } })).status).toBe(400);
    });

    it('keeps multi-line messages, trims the ends, and refuses empty or huge ones', async () => {
      const convo = await direct(alice, bobId);
      await send(alice, convo.id, '  \nLine one\n\nLine two  \n\n');
      expect((await history(alice, convo.id)).messages[0].body).toBe('Line one\n\nLine two');
      expect((await send(alice, convo.id, '   \n  ')).status).toBe(400);
      expect((await send(alice, convo.id, 'x'.repeat(5001))).status).toBe(400);
      expect((await send(alice, convo.id, 'x'.repeat(5000))).status).toBe(200);
    });

    it('stores a retried send once', async () => {
      const convo = await direct(alice, bobId);
      const first = await body(await send(alice, convo.id, 'Once', 'client-abc-1'));
      const again = await body(await send(alice, convo.id, 'Once', 'client-abc-1'));
      expect(again.message.id).toBe(first.message.id);
      expect((await history(alice, convo.id)).messages).toHaveLength(1);
    });

    it('pages back through a long conversation and fetches only what is new', async () => {
      const convo = await direct(alice, bobId);
      for (let i = 1; i <= 60; i++) await send(i % 2 ? alice : bob, convo.id, `m${i}`);
      const latest = await history(alice, convo.id);
      expect(latest.messages).toHaveLength(50);
      expect(latest.more).toBe(true);
      expect(latest.messages[0].body).toBe('m11');
      expect(latest.messages[49].body).toBe('m60');
      const older = await history(alice, convo.id, `?before=${latest.messages[0].id}`);
      expect(older.messages.map((m: { body: string }) => m.body)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
      expect(older.more).toBe(false);
      await send(bob, convo.id, 'm61');
      const newer = await history(alice, convo.id, `?after=${latest.messages[49].id}`);
      expect(newer.messages.map((m: { body: string }) => m.body)).toEqual(['m61']);
      expect((await api(`/api/chat/conversations/${convo.id}/messages?before=-1`, { cookie: alice })).status).toBe(400);
    });

    it('counts unread until read, and never counts your own', async () => {
      const convo = await direct(alice, bobId);
      await send(alice, convo.id, 'one');
      await send(alice, convo.id, 'two');
      const inbox = async (cookie: string) => body(await api('/api/inbox', { cookie, body: {} }));
      expect((await inbox(bob)).chatUnread).toBe(2);
      expect((await inbox(alice)).chatUnread).toBe(0);
      const [listed] = (await body(await api('/api/chat/conversations', { cookie: bob }))).conversations;
      expect(listed.unread).toBe(2);
      expect(listed.lastMessage.preview).toBe('two');

      const { messages } = await history(bob, convo.id);
      await api(`/api/chat/conversations/${convo.id}/read`, { cookie: bob, body: { messageId: messages[0].id } });
      expect((await inbox(bob)).chatUnread).toBe(1);
      await api(`/api/chat/conversations/${convo.id}/read`, { cookie: bob, body: { messageId: messages[1].id } });
      expect((await inbox(bob)).chatUnread).toBe(0);
      // Never backwards, never past the end.
      const back = await body(await api(`/api/chat/conversations/${convo.id}/read`, { cookie: bob, body: { messageId: 0 } }));
      expect(back.lastReadMessageId).toBe(messages[1].id);
      const ahead = await body(await api(`/api/chat/conversations/${convo.id}/read`, { cookie: bob, body: { messageId: 999999 } }));
      expect(ahead.lastReadMessageId).toBe(messages[1].id);
      await send(alice, convo.id, 'three');
      expect((await inbox(bob)).chatUnread).toBe(1);
    });

    it('will not send to someone whose access is off, and keeps what was said', async () => {
      const convo = await direct(alice, bobId);
      await send(alice, convo.id, 'before');
      await getPool().query('update "user" set banned = true where id = $1', [bobId]);
      expect((await send(alice, convo.id, 'after')).status).toBe(409);
      const { messages } = await history(alice, convo.id);
      expect(messages.map((m: { body: string }) => m.body)).toEqual(['before']);
      const [listed] = (await body(await api('/api/chat/conversations', { cookie: alice }))).conversations;
      expect(listed.members.find((m: { id: string }) => m.id === bobId).active).toBe(false);
    });
  });

  describe('groups', () => {
    const group = async (cookie: string, name: string, memberIds: string[]) =>
      api('/api/chat/conversations', { cookie, body: { kind: 'group', name, memberIds } });

    it('creates a named group, and every member sends and reads the history', async () => {
      const convo = await body(await group(alice, 'Sales team', [bobId, carolId]));
      expect(convo.kind).toBe('group');
      expect(convo.title).toBe('Sales team');
      expect(convo.members.map((m: { name: string }) => m.name)).toEqual(['Alice', 'Bob', 'Carol']);
      await send(alice, convo.id, 'Morning all');
      await send(bob, convo.id, 'Morning');
      await send(carol, convo.id, 'Hi');
      const { messages } = await history(carol, convo.id);
      expect(messages.map((m: { senderName: string }) => m.senderName)).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('needs a name and someone else, and only people on the team', async () => {
      expect((await group(alice, '  ', [bobId])).status).toBe(400);
      expect((await group(alice, 'Just me', [aliceId])).status).toBe(400);
      expect((await group(alice, 'Ghosts', [bobId, 'not-a-user'])).status).toBe(400);
      expect((await group(alice, 'x'.repeat(81), [bobId])).status).toBe(400);
    });

    it('adds people, who then see the group; renames it', async () => {
      const convo = await body(await group(alice, 'Deals', [bobId]));
      await send(alice, convo.id, 'first');
      expect((await api(`/api/chat/conversations/${convo.id}`, { cookie: carol })).status).toBe(404);
      const added = await body(await api(`/api/chat/conversations/${convo.id}/members`, { cookie: bob, body: { userIds: [carolId] } }));
      expect(added.members.map((m: { name: string }) => m.name)).toEqual(['Alice', 'Bob', 'Carol']);
      expect((await history(carol, convo.id)).messages).toHaveLength(1);
      // Someone added later does not start with the old messages as unread.
      expect((await body(await api('/api/inbox', { cookie: carol, body: {} }))).chatUnread).toBe(0);
      const renamed = await body(await api(`/api/chat/conversations/${convo.id}/rename`, { cookie: carol, body: { name: 'Deals 2026' } }));
      expect(renamed.title).toBe('Deals 2026');
    });

    describe('history is shared with whoever is in the group (a deliberate rule)', () => {
      const add = (cookie: string, id: string, userIds: string[]) =>
        api(`/api/chat/conversations/${id}/members`, { cookie, body: { userIds } });
      const texts = async (cookie: string, id: string, query = '') =>
        (await history(cookie, id, query)).messages.map((m: { body: string }) => m.body);
      const chatUnread = async (cookie: string) => (await body(await api('/api/inbox', { cookie, body: {} }))).chatUnread;

      it('shows someone added to an existing group everything said before they joined', async () => {
        const convo = await body(await group(alice, 'Deals', [bobId]));
        await send(alice, convo.id, 'before carol 1');
        await send(bob, convo.id, 'before carol 2');
        expect((await add(alice, convo.id, [carolId])).status).toBe(200);
        await send(alice, convo.id, 'after carol');
        expect(await texts(carol, convo.id)).toEqual(['before carol 1', 'before carol 2', 'after carol']);
        // The earlier messages are there to read, not counted as new.
        expect(await chatUnread(carol)).toBe(1);
      });

      it('pages back through the whole history for someone added later', async () => {
        const convo = await body(await group(alice, 'Deals', [bobId]));
        for (let i = 0; i < 55; i++) await send(alice, convo.id, `m${i}`);
        await add(bob, convo.id, [carolId]);
        const first = await history(carol, convo.id);
        expect(first.more).toBe(true);
        const older = await history(carol, convo.id, `?before=${first.messages[0].id}`);
        expect([...older.messages, ...first.messages].map((m: { body: string }) => m.body))
          .toEqual(Array.from({ length: 55 }, (_, i) => `m${i}`));
      });

      it('takes all of it away from someone who leaves, and gives all of it back if they rejoin', async () => {
        const convo = await body(await group(alice, 'Deals', [bobId, carolId]));
        await send(alice, convo.id, 'while carol is in');
        await api(`/api/chat/conversations/${convo.id}/leave`, { cookie: carol, body: {} });
        await send(alice, convo.id, 'while carol is away');
        expect((await api(`/api/chat/conversations/${convo.id}/messages`, { cookie: carol })).status).toBe(404);

        await add(bob, convo.id, [carolId]);
        await send(bob, convo.id, 'carol is back');
        expect(await texts(carol, convo.id)).toEqual(['while carol is in', 'while carol is away', 'carol is back']);
        expect(await chatUnread(carol)).toBe(1);
      });

      it('does the same for someone removed and added back', async () => {
        const convo = await body(await group(alice, 'Deals', [bobId, daveId]));
        await send(dave, convo.id, 'dave was here');
        await api(`/api/chat/conversations/${convo.id}/remove`, { cookie: alice, body: { userId: daveId } });
        await send(alice, convo.id, 'about dave');
        expect((await api(`/api/chat/conversations/${convo.id}`, { cookie: dave })).status).toBe(404);
        await add(alice, convo.id, [daveId]);
        expect(await texts(dave, convo.id)).toEqual(['dave was here', 'about dave']);
      });

      it('never widens to anyone who is not in the group', async () => {
        const convo = await body(await group(alice, 'Deals', [bobId]));
        await send(alice, convo.id, 'members only');
        expect((await api(`/api/chat/conversations/${convo.id}/messages`, { cookie: carol })).status).toBe(404);
        expect((await api(`/api/chat/conversations/${convo.id}/messages`, { cookie: dave })).status).toBe(404);
      });
    });

    it('lets someone leave, after which they cannot read or send', async () => {
      const convo = await body(await group(alice, 'Deals', [bobId, carolId]));
      expect((await api(`/api/chat/conversations/${convo.id}/leave`, { cookie: bob, body: {} })).status).toBe(200);
      expect((await api(`/api/chat/conversations/${convo.id}/messages`, { cookie: bob })).status).toBe(404);
      expect((await send(bob, convo.id, 'still here?')).status).toBe(404);
      const { conversations } = await body(await api('/api/chat/conversations', { cookie: bob }));
      expect(conversations).toHaveLength(0);
    });

    it('lets only the group’s maker or an admin remove someone else', async () => {
      const convo = await body(await group(bob, 'Deals', [aliceId, carolId, daveId]));
      expect((await api(`/api/chat/conversations/${convo.id}/remove`, { cookie: carol, body: { userId: daveId } })).status).toBe(403);
      expect((await api(`/api/chat/conversations/${convo.id}/remove`, { cookie: bob, body: { userId: daveId } })).status).toBe(200);
      expect((await api(`/api/chat/conversations/${convo.id}/remove`, { cookie: alice, body: { userId: carolId } })).status).toBe(200);
      expect((await api(`/api/chat/conversations/${convo.id}`, { cookie: dave })).status).toBe(404);
    });

    it('records group changes for admins, but never the messages or the name', async () => {
      const convo = await body(await group(alice, 'Secret project', [bobId]));
      await send(alice, convo.id, 'the words');
      await api(`/api/chat/conversations/${convo.id}/rename`, { cookie: alice, body: { name: 'Other name' } });
      const { rows } = await getPool().query(`select action, summary from app_audit where collection = 'chat' order by id`);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
      const everything = JSON.stringify((await getPool().query('select * from app_audit')).rows);
      expect(everything).not.toMatch(/Secret project|Other name|the words/);
      // Not in the team's activity history.
      const { entries } = await body(await api('/api/history', { cookie: bob }));
      expect(entries.some((e: { collection: string }) => e.collection === 'chat')).toBe(false);
    });
  });

  describe('who can reach a conversation', () => {
    it('answers every conversation route with 404 for someone who is not a member', async () => {
      const convo = await direct(alice, bobId);
      await send(alice, convo.id, 'private');
      const base = `/api/chat/conversations/${convo.id}`;
      const attempts = [
        api(base, { cookie: carol }),
        api(`${base}/messages`, { cookie: carol }),
        api(`${base}/messages?after=0`, { cookie: carol }),
        api(`${base}/messages`, { cookie: carol, body: { body: 'let me in' } }),
        api(`${base}/read`, { cookie: carol, body: { messageId: 1 } }),
        api(`${base}/rename`, { cookie: carol, body: { name: 'mine now' } }),
        api(`${base}/members`, { cookie: carol, body: { userIds: [carolId] } }),
        api(`${base}/leave`, { cookie: carol, body: {} }),
        api(`${base}/remove`, { cookie: carol, body: { userId: bobId } }),
      ];
      for (const r of await Promise.all(attempts)) expect(r.status).toBe(404);
      // An admin is not a member either.
      const other = await direct(bob, carolId);
      expect((await api(`/api/chat/conversations/${other.id}/messages`, { cookie: alice })).status).toBe(404);
      // A made-up id looks exactly the same.
      const made = await api('/api/chat/conversations/cv_doesnotexist/messages', { cookie: carol });
      expect(made.status).toBe(404);
      expect(await made.json()).toEqual(await (await api(`${base}/messages`, { cookie: carol })).json());
      const { rows } = await getPool().query('select count(*)::int as n from app_message');
      expect(rows[0].n).toBe(1);
    });

    it('does not list other people’s conversations, or leak their unread counts', async () => {
      const convo = await direct(alice, bobId);
      await send(alice, convo.id, 'hi');
      expect((await body(await api('/api/chat/conversations', { cookie: carol }))).conversations).toEqual([]);
      const inbox = await body(await api('/api/inbox', { cookie: carol, body: {} }));
      expect(inbox.conversations).toEqual([]);
      expect(inbox.chatUnread).toBe(0);
    });

    it('needs a session, refuses someone whose access is off, and refuses another site', async () => {
      const convo = await direct(alice, bobId);
      expect((await api('/api/chat/conversations')).status).toBe(401);
      expect((await api(`/api/chat/conversations/${convo.id}/messages`)).status).toBe(401);
      await getPool().query('update "user" set banned = true where id = $1', [bobId]);
      expect((await send(bob, convo.id, 'still?')).status).toBe(401);
      expect((await api('/api/inbox', { cookie: bob, body: {} })).status).toBe(401);
      const r = await api(`/api/chat/conversations/${convo.id}/messages`, {
        cookie: alice, body: { body: 'x' }, headers: { origin: 'https://evil.example' },
      });
      expect(r.status).toBe(403);
    });
  });
});

describe.skipIf(!TEST_DB)('aircraft comments', () => {
  let alice: string;
  let bob: string;
  let carol: string;
  let bobId: string;

  const aircraft = async (cookie: string, id: string, tailNumber: string) => {
    const r = await api('/api/sync', {
      cookie,
      body: { changes: [{ collection: 'aircraft', id, data: { id, tailNumber }, baseVersion: 0 }] },
    });
    expect(r.status).toBe(200);
  };
  const comments = (cookie: string, aircraftId: string) => api(`/api/aircraft/${aircraftId}/comments`, { cookie });
  const comment = (cookie: string, aircraftId: string, text: string) =>
    api(`/api/aircraft/${aircraftId}/comments`, { cookie, body: { body: text } });

  beforeEach(async () => {
    await freshDatabase();
    await createUser('Alice', 'alice@example.com', 'admin');
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    await createUser('Carol', 'carol@example.com');
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
    carol = await signIn('carol@example.com');
    await aircraft(alice, 'air_one', 'N123AB');
    await aircraft(alice, 'air_two', 'N456CD');
  });

  it('adds comments and lists them oldest first with author and time', async () => {
    expect((await comment(alice, 'air_one', 'Insurance documents updated.')).status).toBe(200);
    expect((await comment(bob, 'air_one', 'Client requested revised coverage.\nSee the call notes.')).status).toBe(200);
    const thread = await body(await comments(carol, 'air_one'));
    expect(thread.comments.map((c: { authorName: string }) => c.authorName)).toEqual(['Alice', 'Bob']);
    expect(thread.comments[1].body).toBe('Client requested revised coverage.\nSee the call notes.');
    expect(thread.comments.every((c: { aircraftId: string }) => c.aircraftId === 'air_one')).toBe(true);
    expect(Date.parse(thread.comments[0].createdAt)).not.toBeNaN();
  });

  it('keeps each aircraft’s comments to itself', async () => {
    await comment(alice, 'air_one', 'about one');
    await comment(alice, 'air_two', 'about two');
    const one = await body(await comments(bob, 'air_one'));
    const two = await body(await comments(bob, 'air_two'));
    expect(one.comments.map((c: { body: string }) => c.body)).toEqual(['about one']);
    expect(two.comments.map((c: { body: string }) => c.body)).toEqual(['about two']);
  });

  it('refuses a session-less or disabled person, and an aircraft that does not exist or was deleted', async () => {
    await comment(alice, 'air_one', 'hello');
    expect((await comments('', 'air_one')).status).toBe(401);
    expect((await comment('', 'air_one', 'x')).status).toBe(401);
    expect((await comments(alice, 'air_missing')).status).toBe(404);
    expect((await comment(alice, 'air_missing', 'x')).status).toBe(404);
    // A contact's id is not an aircraft.
    await api('/api/sync', { cookie: alice, body: { changes: [{ collection: 'contacts', id: 'con_1', data: { id: 'con_1' }, baseVersion: 0 }] } });
    expect((await comment(alice, 'con_1', 'x')).status).toBe(404);

    const { rows } = await getPool().query(`select version from app_record where collection = 'aircraft' and id = 'air_one'`);
    await api('/api/sync', { cookie: alice, body: { changes: [{ collection: 'aircraft', id: 'air_one', data: null, baseVersion: rows[0].version }] } });
    expect((await comments(alice, 'air_one')).status).toBe(404);
    expect((await comment(alice, 'air_one', 'x')).status).toBe(404);
    // Deleting the aircraft keeps its comments, for when it is put back.
    expect((await getPool().query('select count(*)::int as n from app_aircraft_comment')).rows[0].n).toBe(1);

    await getPool().query('update "user" set banned = true where id = $1', [bobId]);
    expect((await comment(bob, 'air_two', 'x')).status).toBe(401);
    expect((await comments(bob, 'air_two')).status).toBe(401);
  });

  it('reaches a comment only through its own aircraft', async () => {
    const { comment: c } = await body(await comment(bob, 'air_one', 'on one'));
    // The same comment id under the other aircraft finds nothing to edit or delete.
    expect((await api(`/api/aircraft/air_two/comments/${c.id}/edit`, { cookie: bob, body: { body: 'moved?' } })).status).toBe(404);
    expect((await api(`/api/aircraft/air_two/comments/${c.id}/delete`, { cookie: alice, body: {} })).status).toBe(404);
    expect((await body(await comments(alice, 'air_two'))).comments).toEqual([]);
    expect((await api('/api/aircraft/air_one/comments/not-a-number/edit', { cookie: bob, body: { body: 'x' } })).status).toBe(404);
    expect((await api('/api/aircraft/air_one/comments/999999/delete', { cookie: bob, body: {} })).status).toBe(404);
    const { rows } = await getPool().query('select aircraft_id, body, deleted_at from app_aircraft_comment');
    expect(rows).toEqual([{ aircraft_id: 'air_one', body: 'on one', deleted_at: null }]);
  });

  it('lets the author edit, marks it edited, and keeps what it said before', async () => {
    const { comment: c } = await body(await comment(bob, 'air_one', 'Premium is 4,100'));
    expect((await api(`/api/aircraft/air_one/comments/${c.id}/edit`, { cookie: carol, body: { body: 'hijack' } })).status).toBe(403);
    expect((await api(`/api/aircraft/air_one/comments/${c.id}/edit`, { cookie: alice, body: { body: 'admin edit' } })).status).toBe(403);
    const edited = await body(await api(`/api/aircraft/air_one/comments/${c.id}/edit`, { cookie: bob, body: { body: 'Premium is 4,300' } }));
    expect(edited.comment.body).toBe('Premium is 4,300');
    expect(edited.comment.editedAt).not.toBeNull();
    const { rows } = await getPool().query('select body from app_aircraft_comment_revision where comment_id = $1', [c.id]);
    expect(rows.map((r) => r.body)).toEqual(['Premium is 4,100']);
  });

  it('lets the author or an admin delete, keeping the words in the database only', async () => {
    const first = (await body(await comment(bob, 'air_one', 'first'))).comment;
    const second = (await body(await comment(bob, 'air_one', 'second'))).comment;
    expect((await api(`/api/aircraft/air_one/comments/${first.id}/delete`, { cookie: carol, body: {} })).status).toBe(403);
    expect((await api(`/api/aircraft/air_one/comments/${first.id}/delete`, { cookie: bob, body: {} })).status).toBe(200);
    expect((await api(`/api/aircraft/air_one/comments/${second.id}/delete`, { cookie: alice, body: {} })).status).toBe(200);
    const thread = await body(await comments(carol, 'air_one'));
    expect(thread.comments.map((c: { deleted: boolean; body: string }) => [c.deleted, c.body])).toEqual([[true, ''], [true, '']]);
    expect((await api(`/api/aircraft/air_one/comments/${first.id}/edit`, { cookie: bob, body: { body: 'back' } })).status).toBe(409);
    const { rows } = await getPool().query('select body, deleted_by from app_aircraft_comment order by id');
    expect(rows.map((r) => r.body)).toEqual(['first', 'second']);
  });

  it('checks an edit like a new comment, and keeps an unchanged edit off the record', async () => {
    const { comment: c } = await body(await comment(bob, 'air_one', 'first words'));
    const edit = (text: unknown) => api(`/api/aircraft/air_one/comments/${c.id}/edit`, { cookie: bob, body: { body: text } });
    expect((await edit('   \n  ')).status).toBe(400);
    expect((await edit('x'.repeat(5001))).status).toBe(400);
    expect((await edit(42)).status).toBe(400);
    const same = await body(await edit('first words'));
    expect(same.comment.editedAt).toBeNull();
    const twice = async (text: string) => (await body(await edit(text))).comment;
    await twice('second words');
    expect((await twice('third words\nwith a second line')).body).toBe('third words\nwith a second line');
    const { rows } = await getPool().query('select body from app_aircraft_comment_revision where comment_id = $1 order by id', [c.id]);
    expect(rows.map((r) => r.body)).toEqual(['first words', 'second words']);
    const audit = await getPool().query(`select action from app_audit where collection = 'aircraftComments' order by id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'update', 'update']);
  });

  it('deletes once, keeps a deleted comment out of the new count, and stops a disabled author', async () => {
    const inbox = async (cookie: string) => body(await api('/api/inbox', { cookie, body: {} }));
    const { comment: c } = await body(await comment(alice, 'air_one', 'soon gone'));
    await comment(alice, 'air_one', 'stays');
    expect((await inbox(bob)).aircraftUnread).toEqual({ air_one: 2 });
    const del = () => api(`/api/aircraft/air_one/comments/${c.id}/delete`, { cookie: alice, body: {} });
    expect((await del()).status).toBe(200);
    // Deleting again is a no-op, not a second entry in the log.
    expect((await del()).status).toBe(200);
    const audit = await getPool().query(`select count(*)::int as n from app_audit where collection = 'aircraftComments' and action = 'delete'`);
    expect(audit.rows[0].n).toBe(1);
    expect((await inbox(bob)).aircraftUnread).toEqual({ air_one: 1 });

    const { comment: mine } = await body(await comment(bob, 'air_one', 'mine'));
    await getPool().query('update "user" set banned = true where id = $1', [bobId]);
    expect((await api(`/api/aircraft/air_one/comments/${mine.id}/edit`, { cookie: bob, body: { body: 'x' } })).status).toBe(401);
    expect((await api(`/api/aircraft/air_one/comments/${mine.id}/delete`, { cookie: bob, body: {} })).status).toBe(401);
  });

  it('reports Watch / Watching per person, and starts watching on commenting unless told otherwise', async () => {
    const watching = async (cookie: string) => (await body(await comments(cookie, 'air_one'))).watching;
    const watch = (cookie: string, value: unknown, id = 'air_one') => api(`/api/aircraft/${id}/watch`, { cookie, body: { watching: value } });
    expect(await watching(bob)).toBe(false);
    await comment(bob, 'air_one', 'hello');
    expect(await watching(bob)).toBe(true);
    expect(await watching(carol)).toBe(false);
    expect(await body(await watch(bob, false))).toEqual({ watching: false });
    expect(await watching(bob)).toBe(false);
    await comment(bob, 'air_one', 'again');
    expect(await watching(bob)).toBe(false);
    expect(await body(await watch(carol, true))).toEqual({ watching: true });
    expect(await watching(carol)).toBe(true);
    // Watching one aircraft is not watching another.
    expect((await body(await comments(carol, 'air_two'))).watching).toBe(false);
    expect((await watch(carol, 'yes')).status).toBe(400);
    expect((await watch('', true)).status).toBe(401);
    expect((await watch(carol, true, 'air_missing')).status).toBe(404);
  });

  it('shows how many are new since each person last looked', async () => {
    const inbox = async (cookie: string) => body(await api('/api/inbox', { cookie, body: {} }));
    await comment(alice, 'air_one', 'a');
    await comment(alice, 'air_one', 'b');
    expect((await inbox(bob)).aircraftUnread).toEqual({ air_one: 2 });
    expect((await inbox(alice)).aircraftUnread).toEqual({});
    const thread = await body(await comments(bob, 'air_one'));
    expect(thread.lastReadCommentId).toBe(0);
    await api('/api/aircraft/air_one/comments/read', { cookie: bob, body: { commentId: thread.comments[1].id } });
    expect((await inbox(bob)).aircraftUnread).toEqual({});
    await comment(carol, 'air_one', 'c');
    expect((await inbox(bob)).aircraftUnread).toEqual({ air_one: 1 });
    // Marking read cannot run past the end, or move backwards.
    const r = await body(await api('/api/aircraft/air_one/comments/read', { cookie: bob, body: { commentId: 99999 } }));
    const last = (await body(await comments(bob, 'air_one'))).comments.at(-1).id;
    expect(r.lastReadCommentId).toBe(last);
    // A comment read on one aircraft is not read on another.
    await comment(alice, 'air_two', 'elsewhere');
    expect((await inbox(bob)).aircraftUnread).toEqual({ air_two: 1 });
  });

  it('records comments in the activity history by tail, never by what they say', async () => {
    const { comment: c } = await body(await comment(bob, 'air_one', 'the insurance quote is 4,100'));
    await api(`/api/aircraft/air_one/comments/${c.id}/edit`, { cookie: bob, body: { body: 'changed words' } });
    const { entries } = await body(await api('/api/history', { cookie: alice }));
    const mine = entries.filter((e: { collection: string }) => e.collection === 'aircraftComments');
    expect(mine.map((e: { action: string; summary: string; recordId: string }) => [e.action, e.summary, e.recordId]))
      .toEqual([['update', 'N123AB', 'air_one'], ['create', 'N123AB', 'air_one']]);
    const everything = JSON.stringify((await getPool().query('select * from app_audit')).rows);
    expect(everything).not.toMatch(/insurance quote|changed words/);
  });
});
