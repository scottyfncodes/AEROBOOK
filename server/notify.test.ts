/**
 * The notification layer and web push against a real Postgres, with the
 * push services themselves replaced by a recorder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';
import { setPushSender, type PushOutcome, type PushPayload, type StoredSubscription } from './push.js';
import { describePush, linkFor, topicFor } from './notify.js';

async function body<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface Sent {
  endpoint: string;
  payload: PushPayload;
  topic: string;
}

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const endpoint = (n: string, host = 'fcm.googleapis.com') => `https://${host}/fcm/send/${n}`;

describe('what a notification says', () => {
  it('names who and where, never what was said', () => {
    expect(describePush({ kind: 'message', actorName: 'Scott', unread: 1 }).body).toBe('New message from Scott');
    expect(describePush({ kind: 'message', actorName: 'Scott', unread: 1, groupName: 'Sales team' }).body)
      .toBe('New message in Sales team from Scott');
    expect(describePush({ kind: 'comment', actorName: 'Scott', unread: 1, tail: 'N123AB' }).body)
      .toBe('New comment on N123AB from Scott');
    expect(describePush({ kind: 'message', actorName: 'Scott', unread: 3 }).body).toBe('3 new messages · latest from Scott');
    expect(describePush({ kind: 'comment', actorName: 'Scott', unread: 2, tail: 'N123AB' }).body)
      .toBe('2 new comments on N123AB · latest from Scott');
    expect(describePush({ kind: 'message', actorName: 'Scott', unread: 1 }).title).toBe('AEROBOOK');
    expect(describePush({ kind: 'task', actorName: 'Scott', unread: 1, label: 'Send quote' }).body)
      .toBe('Scott assigned you a task: Send quote');
  });

  it('opens the conversation, or the aircraft at its comments', () => {
    expect(linkFor('conv:cv_abc')).toBe('/chat/cv_abc');
    expect(linkFor('aircraft:air_1')).toBe('/aircraft/air_1#comments');
    expect(linkFor('aircraft:a/b')).toBe('/aircraft/a%2Fb#comments');
    expect(linkFor('task:fup_1')).toBe('/follow-ups');
    expect(topicFor('conv:cv_abc')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicFor('conv:cv_abc')).not.toBe(topicFor('conv:cv_abd'));
  });
});

describe.skipIf(!TEST_DB)('notifications', () => {
  let alice: string;
  let bob: string;
  let carol: string;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let daveId: string;
  let sent: Sent[];
  let outcome: (s: StoredSubscription) => PushOutcome;

  beforeEach(async () => {
    await freshDatabase();
    process.env.VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.VAPID_PRIVATE_KEY = 'test-private-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    sent = [];
    outcome = () => 'sent';
    setPushSender(async (subscription, payload, topic) => {
      sent.push({ endpoint: subscription.endpoint, payload, topic });
      return outcome(subscription);
    });
    aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    carolId = (await createUser('Carol', 'carol@example.com')).id;
    daveId = (await createUser('Dave', 'dave@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
    carol = await signIn('carol@example.com');
  });

  afterEach(() => {
    setPushSender(null);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  const subscribe = (cookie: string, url: string) =>
    api('/api/push/subscribe', { cookie, body: { subscription: { endpoint: url, keys: KEYS } } });
  const direct = async (cookie: string, userId: string) =>
    (await body(await api('/api/chat/conversations', { cookie, body: { kind: 'direct', userId } }))).id as string;
  const group = async (cookie: string, memberIds: string[]) =>
    (await body(await api('/api/chat/conversations', { cookie, body: { kind: 'group', name: 'Sales team', memberIds } }))).id as string;
  const send = (cookie: string, id: string, text: string, clientId?: string) =>
    api(`/api/chat/conversations/${id}/messages`, { cookie, body: { body: text, clientId } });
  const notifications = async () => (await getPool().query(
    `select n.user_id, n.kind, n.thread, n.push_status from app_notification n order by n.id`,
  )).rows;
  const aircraft = async (id: string, tailNumber: string) => {
    await api('/api/sync', { cookie: alice, body: { changes: [{ collection: 'aircraft', id, data: { id, tailNumber }, baseVersion: 0 }] } });
  };

  describe('assigned tasks', () => {
    const save = (cookie: string, data: Record<string, unknown>, baseVersion = 0) =>
      api('/api/sync', { cookie, body: { changes: [{ collection: 'followUps', data, id: data.id, baseVersion }] } });
    const task = (over: Record<string, unknown> = {}) => ({
      id: 'fup_1', kind: 'quote', note: 'Hull and liability, $1M on N123AB', dueDate: '2026-10-02',
      completed: false, contactId: null, aircraftId: null, opportunityId: null, ...over,
    });

    it('tells the person given a task, with what to do but not the note', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      await save(alice, task({ assigneeId: bobId }));
      expect(await notifications()).toEqual([{ user_id: bobId, kind: 'task', thread: 'task:fup_1', push_status: 'sent' }]);
      expect(sent[0].payload).toEqual({
        title: 'AEROBOOK', body: 'Alice assigned you a task: Send quote', url: '/follow-ups', tag: 'task:fup_1',
      });
      expect(JSON.stringify(sent[0])).not.toMatch(/Hull|1M|N123AB/);
    });

    it('says nothing for your own task, an unassigned one, a finished one, or an edit that keeps who has it', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      await save(bob, task({ id: 'fup_mine', assigneeId: bobId }));
      await save(alice, task({ id: 'fup_open', assigneeId: null }));
      await save(alice, task({ id: 'fup_done', assigneeId: bobId, completed: true }));
      expect(await notifications()).toEqual([]);

      await save(alice, task({ assigneeId: bobId }));
      await save(alice, task({ assigneeId: bobId, note: 'changed' }), 1);
      expect((await notifications()).map((n) => n.user_id)).toEqual([bobId]);
    });

    it('tells the new person when a task is passed on, and never someone whose access is off', async () => {
      await save(alice, task({ assigneeId: null }));
      await save(alice, task({ assigneeId: carolId }), 1);
      await getPool().query('update "user" set banned = true where id = $1', [daveId]);
      await save(alice, task({ id: 'fup_2', assigneeId: daveId }));
      expect((await notifications()).map((n) => n.user_id)).toEqual([carolId]);
    });

    it('pops up in the app while it is open, while the task is still theirs', async () => {
      const since = (await body(await api('/api/inbox', { cookie: bob, body: {} }))).cursor;
      await save(alice, task({ assigneeId: bobId }));
      const { events } = await body(await api('/api/inbox', { cookie: bob, body: { since } }));
      expect(events.map((e: { text: string; url: string }) => [e.text, e.url]))
        .toEqual([['Alice assigned you a task: Send quote', '/follow-ups']]);

      await save(alice, task({ assigneeId: carolId }), 1);
      expect((await body(await api('/api/inbox', { cookie: bob, body: { since } }))).events).toEqual([]);
    });
  });

  describe('chat', () => {
    it('notifies the other person, not the sender, with a push that opens the conversation', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      await subscribe(alice, endpoint('alice-phone'));
      const id = await direct(alice, bobId);
      await send(alice, id, 'The quote for N123AB is $4,100 with Skyward');
      expect(await notifications()).toEqual([{ user_id: bobId, kind: 'message', thread: `conv:${id}`, push_status: 'sent' }]);
      expect(sent).toHaveLength(1);
      expect(sent[0].endpoint).toBe(endpoint('bob-phone'));
      expect(sent[0].payload).toEqual({ title: 'AEROBOOK', body: 'New message from Alice', url: `/chat/${id}`, tag: `conv:${id}` });
      expect(JSON.stringify(sent[0])).not.toMatch(/quote|4,100|Skyward|N123AB/);
    });

    it('notifies the current members of a group — not the sender, anyone who left, or anyone whose access is off', async () => {
      const id = await group(alice, [bobId, carolId, daveId]);
      await api(`/api/chat/conversations/${id}/leave`, { cookie: carol, body: {} });
      await getPool().query('update "user" set banned = true where id = $1', [daveId]);
      await send(alice, id, 'hello');
      expect((await notifications()).map((n) => n.user_id)).toEqual([bobId]);
      await send(bob, id, 'hi');
      expect((await notifications()).map((n) => n.user_id)).toEqual([bobId, aliceId]);
    });

    it('names the group in the push', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await group(alice, [bobId]);
      await send(alice, id, 'hello');
      expect(sent[0].payload.body).toBe('New message in Sales team from Alice');
    });

    it('announces a retried send once', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      await send(alice, id, 'once', 'retry-me-1');
      await send(alice, id, 'once', 'retry-me-1');
      expect(await notifications()).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });

    it('holds back a second push while the first is unread, then says how many are waiting', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      await send(alice, id, 'one');
      await send(alice, id, 'two');
      await send(alice, id, 'three');
      expect((await notifications()).map((n) => n.push_status)).toEqual(['sent', 'grouped', 'grouped']);
      expect(sent).toHaveLength(1);
      // Nothing is lost: every message is unread.
      expect((await body(await api('/api/inbox', { cookie: bob, body: {} }))).chatUnread).toBe(3);

      // Two minutes on, the next one goes, counting what is waiting.
      await getPool().query(`update app_notification set created_at = now() - interval '3 minutes'`);
      await send(alice, id, 'four');
      expect(sent).toHaveLength(2);
      expect(sent[1].payload.body).toBe('4 new messages · latest from Alice');
    });

    it('sends one push, not several, for messages arriving at the same moment', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      await Promise.all(['a', 'b', 'c', 'd'].map((t) => send(alice, id, t)));
      expect(sent).toHaveLength(1);
      expect((await notifications()).map((n) => n.push_status).sort()).toEqual(['grouped', 'grouped', 'grouped', 'sent']);
      expect((await body(await api('/api/inbox', { cookie: bob, body: {} }))).chatUnread).toBe(4);
    });

    it('pushes again straight away once the earlier one has been read', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      const first = (await body(await send(alice, id, 'one'))).message;
      await api(`/api/chat/conversations/${id}/read`, { cookie: bob, body: { messageId: first.id } });
      await send(alice, id, 'two');
      expect(sent).toHaveLength(2);
      expect(sent[1].payload.body).toBe('New message from Alice');
    });

    it('does not group pushes across different conversations', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const one = await direct(alice, bobId);
      const two = await direct(carol, bobId);
      await send(alice, one, 'a');
      await send(carol, two, 'b');
      expect(sent.map((s) => s.payload.tag)).toEqual([`conv:${one}`, `conv:${two}`]);
    });

    it('sends no push while the person has the app open, but still shows it in the app', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      const first = await body(await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: 'app' } }));
      expect(first.events).toEqual([]);
      await send(alice, id, 'hello');
      expect(sent).toHaveLength(0);
      expect((await notifications())[0].push_status).toBe('present');
      const next = await body(await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: 'app', since: first.cursor } }));
      expect(next.events).toHaveLength(1);
      expect(next.events[0]).toMatchObject({ kind: 'message', thread: `conv:${id}`, url: `/chat/${id}`, text: 'New message from Alice' });
      // The same event is not handed over twice.
      const again = await body(await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: 'app', since: next.cursor } }));
      expect(again.events).toEqual([]);

      // Closing the app, or going quiet, lets pushes through again.
      await api('/api/presence', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: null } });
      await send(alice, id, 'are you there?');
      expect(sent).toHaveLength(1);
      await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: `conv:${id}` } });
      await getPool().query(`update app_presence set seen_at = now() - interval '2 minutes'`);
      await api(`/api/chat/conversations/${id}/read`, { cookie: bob, body: { messageId: 999999 } });
      await send(alice, id, 'again');
      expect(sent).toHaveLength(2);
    });

    it('leaves a group’s events out of the inbox for someone who has left it', async () => {
      const id = await group(alice, [bobId, carolId]);
      const start = await body(await api('/api/inbox', { cookie: carol, body: {} }));
      await send(alice, id, 'hello');
      await api(`/api/chat/conversations/${id}/leave`, { cookie: carol, body: {} });
      const later = await body(await api('/api/inbox', { cookie: carol, body: { since: start.cursor } }));
      expect(later.events).toEqual([]);
    });

    it('still delivers the message when a push fails', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      setPushSender(async () => { throw new Error('push service down'); });
      const id = await direct(alice, bobId);
      expect((await send(alice, id, 'hello')).status).toBe(200);
      expect((await notifications())[0].push_status).toBe('failed');
      expect((await body(await api('/api/inbox', { cookie: bob, body: {} }))).chatUnread).toBe(1);
    });

    describe('when a push fails', () => {
      const chatUnread = async (cookie: string) => (await body(await api('/api/inbox', { cookie, body: {} }))).chatUnread;

      /** A push service that holds each push until the test says how it went. */
      function heldPushes() {
        const waiting: { endpoint: string; body: string; settle: (o: PushOutcome) => void }[] = [];
        let arrived: () => void = () => undefined;
        setPushSender((subscription, payload) => new Promise<PushOutcome>((settle) => {
          waiting.push({ endpoint: subscription.endpoint, body: payload.body, settle });
          arrived();
        }));
        const next = () => new Promise<void>((resolve) => { arrived = resolve; });
        return { waiting, next };
      }

      it('groups the next message normally when the first push succeeded', async () => {
        await subscribe(bob, endpoint('bob-phone'));
        const id = await direct(alice, bobId);
        await send(alice, id, 'one');
        await send(alice, id, 'two');
        expect((await notifications()).map((n) => n.push_status)).toEqual(['sent', 'grouped']);
        expect(sent).toHaveLength(1);
        expect(await chatUnread(bob)).toBe(2);
      });

      it('pushes the next message when the push before it failed', async () => {
        await subscribe(bob, endpoint('bob-phone'));
        const id = await direct(alice, bobId);
        outcome = () => 'failed';
        await send(alice, id, 'one');
        outcome = () => 'sent';
        await send(alice, id, 'two');
        expect((await notifications()).map((n) => n.push_status)).toEqual(['failed', 'sent']);
        expect(sent).toHaveLength(2);
        expect(sent[1].payload.body).toBe('2 new messages · latest from Alice');
        expect(await chatUnread(bob)).toBe(2);
      });

      it('pushes a message held back behind a push that then fails', async () => {
        await subscribe(bob, endpoint('bob-phone'));
        const id = await direct(alice, bobId);
        const held = heldPushes();

        // The first push is on its way when the second message arrives...
        let arrived = held.next();
        const first = send(alice, id, 'one');
        await arrived;
        expect((await send(alice, id, 'two')).status).toBe(200);
        expect((await notifications()).map((n) => n.push_status)).toEqual(['sent', 'grouped']);
        expect(held.waiting).toHaveLength(1);

        // ...and then the push service turns the first one down.
        arrived = held.next();
        held.waiting[0].settle('failed');
        await arrived;
        expect(held.waiting).toHaveLength(2);
        expect(held.waiting[1].body).toBe('2 new messages · latest from Alice');
        held.waiting[1].settle('sent');
        expect((await first).status).toBe(200);

        expect((await notifications()).map((n) => n.push_status)).toEqual(['failed', 'sent']);
        expect(await chatUnread(bob)).toBe(2);
      });

      it('sends one push for everything held back behind a failed one, naming the latest sender', async () => {
        await subscribe(bob, endpoint('bob-phone'));
        const id = await group(alice, [bobId, carolId]);
        const held = heldPushes();

        let arrived = held.next();
        const first = send(alice, id, 'one');
        await arrived;
        await send(alice, id, 'two');
        await send(carol, id, 'three');
        await send(carol, id, 'four');
        expect(held.waiting).toHaveLength(1);

        arrived = held.next();
        held.waiting[0].settle('failed');
        await arrived;
        held.waiting[1].settle('sent');
        await first;
        expect(held.waiting.map((w) => w.body)).toEqual([
          'New message in Sales team from Alice',
          '4 new messages in Sales team · latest from Carol',
        ]);
        const bobs = (await notifications()).filter((n) => n.user_id === bobId).map((n) => n.push_status);
        expect(bobs).toEqual(['failed', 'grouped', 'grouped', 'sent']);
        expect(await chatUnread(bob)).toBe(4);
        // Carol replied, which reads what came before; her own never count.
        expect(await chatUnread(carol)).toBe(0);

        // The replacement push starts a new two-minute hold, as any push does.
        await send(alice, id, 'five');
        expect(held.waiting).toHaveLength(2);
        expect(await chatUnread(bob)).toBe(5);
      });

      it('sends nothing in its place if the person has since opened the app or read the messages', async () => {
        await subscribe(bob, endpoint('bob-phone'));
        const id = await direct(alice, bobId);
        const held = heldPushes();

        let arrived = held.next();
        const first = send(alice, id, 'one');
        await arrived;
        const two = (await body(await send(alice, id, 'two'))).message;
        await api(`/api/chat/conversations/${id}/read`, { cookie: bob, body: { messageId: two.id } });

        held.waiting[0].settle('failed');
        await first;
        expect(held.waiting).toHaveLength(1);
        expect(await chatUnread(bob)).toBe(0);

        // Same again, with Bob in the app instead of having read it.
        arrived = held.next();
        const three = send(alice, id, 'three');
        await arrived;
        await send(alice, id, 'four');
        await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-laptop-1', view: 'app' } });
        held.waiting[1].settle('failed');
        await three;
        expect(held.waiting).toHaveLength(2);
        expect(await chatUnread(bob)).toBe(2);
      });

      it('does the same for aircraft comments', async () => {
        await aircraft('air_one', 'N123AB');
        await subscribe(bob, endpoint('bob-phone'));
        await api('/api/aircraft/air_one/watch', { cookie: bob, body: { watching: true } });
        const held = heldPushes();

        let arrived = held.next();
        const first = api('/api/aircraft/air_one/comments', { cookie: alice, body: { body: 'one' } });
        await arrived;
        await api('/api/aircraft/air_one/comments', { cookie: alice, body: { body: 'two' } });
        arrived = held.next();
        held.waiting[0].settle('failed');
        await arrived;
        held.waiting[1].settle('sent');
        await first;
        expect(held.waiting.map((w) => w.body)).toEqual([
          'New comment on N123AB from Alice',
          '2 new comments on N123AB · latest from Alice',
        ]);
        expect((await body(await api('/api/inbox', { cookie: bob, body: {} }))).aircraftUnread).toEqual({ air_one: 2 });
      });
    });

    it('records the notification without pushing when push is not set up', async () => {
      delete process.env.VAPID_PRIVATE_KEY;
      await subscribe(bob, endpoint('bob-phone'));
      const id = await direct(alice, bobId);
      await send(alice, id, 'hello');
      expect((await notifications())[0].push_status).toBe('off');
      expect(sent).toHaveLength(0);
    });
  });

  describe('aircraft comments', () => {
    const comment = (cookie: string, id: string, text: string) => api(`/api/aircraft/${id}/comments`, { cookie, body: { body: text } });

    it('notifies the people in that aircraft’s discussion, not the whole team', async () => {
      await aircraft('air_one', 'N123AB');
      await subscribe(bob, endpoint('bob-phone'));
      await comment(alice, 'air_one', 'Insurance documents updated.');
      // Nobody else is in the discussion yet.
      expect(await notifications()).toEqual([]);
      await comment(bob, 'air_one', 'Client requested revised coverage.');
      expect((await notifications()).map((n) => [n.user_id, n.thread])).toEqual([[aliceId, 'aircraft:air_one']]);
      await comment(alice, 'air_one', 'Added the new PDF to Documents.');
      expect((await notifications()).map((n) => n.user_id)).toEqual([aliceId, bobId]);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual({
        title: 'AEROBOOK', body: 'New comment on N123AB from Alice', url: '/aircraft/air_one#comments', tag: 'aircraft:air_one',
      });
      expect(JSON.stringify(sent)).not.toMatch(/PDF|Documents/);
      // Carol never took part, so never heard.
      expect((await notifications()).some((n) => n.user_id === carolId)).toBe(false);
    });

    it('lets someone watch without commenting, or stop watching', async () => {
      await aircraft('air_one', 'N123AB');
      let seen = 0;
      /** Who was notified about the comment just made. */
      const heard = async () => {
        const rows = await notifications();
        const fresh = rows.slice(seen).map((n) => n.user_id).sort();
        seen = rows.length;
        return fresh;
      };
      await api('/api/aircraft/air_one/watch', { cookie: carol, body: { watching: true } });
      await comment(alice, 'air_one', 'first');
      expect(await heard()).toEqual([carolId]);
      await comment(bob, 'air_one', 'second');
      expect(await heard()).toEqual([aliceId, carolId].sort());
      await api('/api/aircraft/air_one/watch', { cookie: alice, body: { watching: false } });
      await comment(carol, 'air_one', 'third');
      expect(await heard()).toEqual([bobId]);
      // Commenting again does not quietly undo "stop watching".
      await comment(alice, 'air_one', 'fourth');
      expect(await heard()).toEqual([bobId, carolId].sort());
      await comment(bob, 'air_one', 'fifth');
      expect(await heard()).toEqual([carolId]);
    });

    it('does not notify someone whose access is off', async () => {
      await aircraft('air_one', 'N123AB');
      await comment(bob, 'air_one', 'first');
      await getPool().query('update "user" set banned = true where id = $1', [bobId]);
      await comment(alice, 'air_one', 'second');
      expect(await notifications()).toEqual([]);
    });

    it('refuses to watch an aircraft that does not exist', async () => {
      expect((await api('/api/aircraft/air_nope/watch', { cookie: carol, body: { watching: true } })).status).toBe(404);
    });
  });

  describe('push subscriptions', () => {
    it('keeps several devices per person and sends to each', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      await subscribe(bob, endpoint('bob-laptop', 'web.push.apple.com'));
      const status = await body(await api('/api/push/status', { cookie: bob, body: { endpoint: endpoint('bob-phone') } }));
      expect(status).toEqual({ devices: 2, thisDevice: true });
      const id = await direct(alice, bobId);
      await send(alice, id, 'hello');
      expect(sent.map((s) => s.endpoint).sort()).toEqual([endpoint('bob-laptop', 'web.push.apple.com'), endpoint('bob-phone')].sort());
    });

    it('forgets a device its push service says is gone, and keeps the others', async () => {
      await subscribe(bob, endpoint('bob-old'));
      await subscribe(bob, endpoint('bob-new'));
      outcome = (s) => (s.endpoint === endpoint('bob-old') ? 'gone' : 'sent');
      const id = await direct(alice, bobId);
      await send(alice, id, 'hello');
      const { rows } = await getPool().query('select endpoint from app_push_subscription');
      expect(rows.map((r) => r.endpoint)).toEqual([endpoint('bob-new')]);
      expect((await notifications())[0].push_status).toBe('sent');
    });

    it('belongs to whoever is signed in on that device now', async () => {
      await subscribe(bob, endpoint('shared-ipad'));
      await subscribe(carol, endpoint('shared-ipad'));
      const { rows } = await getPool().query('select user_id from app_push_subscription');
      expect(rows).toEqual([{ user_id: carolId }]);
      const id = await direct(alice, bobId);
      await send(alice, id, 'for bob only');
      expect(sent).toHaveLength(0);
    });

    it('lets nobody remove or read someone else’s subscription', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      const r = await body(await api('/api/push/unsubscribe', { cookie: carol, body: { endpoint: endpoint('bob-phone') } }));
      expect(r.removed).toBe(false);
      expect((await getPool().query('select count(*)::int as n from app_push_subscription')).rows[0].n).toBe(1);
      expect(await body(await api('/api/push/status', { cookie: carol, body: { endpoint: endpoint('bob-phone') } })))
        .toEqual({ devices: 0, thisDevice: false });
      const mine = await body(await api('/api/push/unsubscribe', { cookie: bob, body: { endpoint: endpoint('bob-phone') } }));
      expect(mine.removed).toBe(true);
    });

    it('only accepts real push services, so the server cannot be pointed anywhere else', async () => {
      for (const bad of [
        'http://fcm.googleapis.com/fcm/send/x',
        'https://localhost/x',
        'https://169.254.169.254/latest/meta-data',
        'https://evil.example/fcm.googleapis.com',
        'https://fcm.googleapis.com.evil.example/x',
        'https://fcm.googleapis.com:8443/x',
        'https://user:pass@fcm.googleapis.com/x',
        'not a url',
      ]) {
        expect((await subscribe(bob, bad)).status, bad).toBe(400);
      }
      for (const good of [
        'https://fcm.googleapis.com/fcm/send/abc',
        'https://web.push.apple.com/QGx',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://wns2-by3p.notify.windows.com/w/?token=abc',
      ]) {
        expect((await subscribe(bob, good)).status, good).toBe(200);
      }
      const badKeys = await api('/api/push/subscribe', {
        cookie: bob, body: { subscription: { endpoint: endpoint('x'), keys: { p256dh: '<script>', auth: 'a' } } },
      });
      expect(badKeys.status).toBe(400);
    });

    it('needs a session', async () => {
      expect((await api('/api/push/subscribe', { body: { subscription: { endpoint: endpoint('x'), keys: KEYS } } })).status).toBe(401);
      expect((await api('/api/push/config')).status).toBe(401);
    });

    it('hands out the public key only, and says when push is off', async () => {
      const on = await body(await api('/api/push/config', { cookie: bob }));
      expect(on).toEqual({ enabled: true, publicKey: 'test-public-key' });
      expect(JSON.stringify(on)).not.toMatch(/private/);
      delete process.env.VAPID_PUBLIC_KEY;
      expect(await body(await api('/api/push/config', { cookie: bob }))).toEqual({ enabled: false, publicKey: null });
    });

    it('sends a test notification to your own devices only', async () => {
      await subscribe(bob, endpoint('bob-phone'));
      await subscribe(carol, endpoint('carol-phone'));
      const r = await body(await api('/api/push/test', { cookie: bob, body: {} }));
      expect(r).toMatchObject({ sent: 1, devices: 1 });
      expect(sent.map((s) => s.endpoint)).toEqual([endpoint('bob-phone')]);
    });

    it('stops a disabled person subscribing', async () => {
      await getPool().query('update "user" set banned = true where id = $1', [bobId]);
      expect((await subscribe(bob, endpoint('bob-phone'))).status).toBe(401);
    });
  });
});
