/**
 * Which push endpoints the server will send to. The server makes the
 * request, so an endpoint that points anywhere but a real push service is a
 * way to make it call into its own network (server-side request forgery).
 *
 * The check has to agree with what web-push actually connects to, and
 * web-push reads the URL with Node's legacy url.parse(), not the WHATWG URL
 * parser — so every accepted endpoint is also checked against url.parse().
 */
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { parse as parseUrl } from 'node:url';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPushEndpoint, isPushHost, pushToUser, setPushSender } from './push.js';
import { createUser, freshDatabase, TEST_DB } from './testing.js';
import { getPool } from './db.js';

const VALID = [
  'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ',
  'https://fcm.googleapis.com/wp/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZ',
  'https://web.push.apple.com/QGx7ZkP3Vd8Q-Wb0k2nQ4J9ysT1fXw_abc',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc_def',
  'https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB%2Babc%3D',
];

/** The demonstrated bypass, and other ways the two URL parsers read one string differently. */
const PARSER_DISAGREEMENT = [
  'https://169.254.169.254;.fcm.googleapis.com/latest',
  'https://169.254.169.254;.fcm.googleapis.com/latest/meta-data/iam/security-credentials/',
  'https://127.0.0.1;.web.push.apple.com/x',
  'https://localhost;.fcm.googleapis.com/x',
  'https://169.254.169.254\\.fcm.googleapis.com/x',
  'https://fcm.googleapis.com\\@169.254.169.254/x',
  'https://169.254.169.254\\@fcm.googleapis.com/x',
  'https://169.254.169.254%2f.fcm.googleapis.com/x',
  'https://169.254.169.254%3b.fcm.googleapis.com/x',
  'https://169.254.169.254 .fcm.googleapis.com/x',
  'https://169.254.169.254\t.fcm.googleapis.com/x',
  'https://169.254.169.254\n.fcm.googleapis.com/x',
  'https://169.254.169.254,.fcm.googleapis.com/x',
  'https://169.254.169.254!.fcm.googleapis.com/x',
  'https://169.254.169.254$.fcm.googleapis.com/x',
  "https://169.254.169.254'.fcm.googleapis.com/x",
  'https://169.254.169.254*.fcm.googleapis.com/x',
  'https://169.254.169.254_.fcm.googleapis.com/x',
  'https://169.254.169.254~.fcm.googleapis.com/x',
  'https://169.254.169.254|.fcm.googleapis.com/x',
  'https://169.254.169.254^.fcm.googleapis.com/x',
  'https://169.254.169.254`.fcm.googleapis.com/x',
  'https://169.254.169.254{.fcm.googleapis.com/x',
  'https://169.254.169.254<.fcm.googleapis.com/x',
  'https://169.254.169.254".fcm.googleapis.com/x',
  'https://169.254.169.254#.fcm.googleapis.com/x',
  'https://169.254.169.254?.fcm.googleapis.com/x',
  'https://169.254.169.254@fcm.googleapis.com/x',
  'https://fcm.googleapis.com@169.254.169.254/x',
  'https://fcm.googleapis.com:443@169.254.169.254/x',
  'https://fcm.googleapis.com#@169.254.169.254/x',
  'https://fcm.googleapis.com?@169.254.169.254/x',
  'https:/fcm.googleapis.com/x',
  'https:fcm.googleapis.com/x',
  'https:\\\\fcm.googleapis.com/x',
  'https:///fcm.googleapis.com/x',
  'https://fcm.googleapis.com/x#frag',
  'https://fcm.googleapis.com/x y',
  'https://fcm.googleapis.com/x\\y',
  'https://fcm.googleapis.com/%zz',
  ' https://fcm.googleapis.com/x',
  'https://fcm.googleapis.com/x ',
  'https://fcm.googleapis.com/x\n',
  'HTTPS://fcm.googleapis.com/x',
  'https://FCM.googleapis.com/x',
  'https://fcm.googleapis.com./x',
  'https://fcm.googleapis.com%2e/x',
  'https://fcm%2egoogleapis.com/x',
  'https://ｆｃｍ.googleapis.com/x',
  'https://fcm.googleapis.com。/x',
  'https://xn--fcm-googleapis-com/x',
  'https://fcm.googleapis.com\u0000.evil.example/x',
];

const LOCAL = [
  'https://localhost/x',
  'https://localhost:443/x',
  'https://localhost./x',
  'https://127.0.0.1/x',
  'https://127.1/x',
  'https://0.0.0.0/x',
  'https://0/x',
  'https://2130706433/x',
  'https://0x7f000001/x',
  'https://[::1]/x',
  'https://[::ffff:127.0.0.1]/x',
  'https://169.254.169.254/latest/meta-data',
  'https://[fd00:ec2::254]/latest/meta-data',
  'https://10.0.0.1/x',
  'https://192.168.1.1/x',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://localhost.fcm.googleapis.com/x',
  'https://127.0.0.1.nip.io/x',
];

const ELSEWHERE = [
  'https://evil.example/fcm/send/x',
  'https://evil.example/fcm.googleapis.com',
  'https://fcm.googleapis.com.evil.example/x',
  'https://evilfcm.googleapis.com/x',
  'https://googleapis.com/x',
  'https://x.fcm.googleapis.com/x',
  'https://apple.com/x',
  'https://evil.web.push.apple.com/x',
  'https://notify.windows.com/w/?token=x',
  'https://a.b.notify.windows.com/w/?token=x',
  'https://evil.example.notify.windows.com.evil.example/x',
  'https://-bad.notify.windows.com/x',
];

const MALFORMED: unknown[] = [
  '', 'not a url', 'https://', 'https:///', 'https://fcm.googleapis.com', '//fcm.googleapis.com/x', 'fcm.googleapis.com/x',
  'http://fcm.googleapis.com/fcm/send/x', 'ftp://fcm.googleapis.com/x', 'javascript:alert(1)', 'data:text/plain,x',
  'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com:443/x', 'https://fcm.googleapis.com:/x',
  'https://user:pass@fcm.googleapis.com/x', 'https://user@fcm.googleapis.com/x', 'https://:@fcm.googleapis.com/x',
  `https://fcm.googleapis.com/${'a'.repeat(1000)}`,
  null, undefined, 42, {}, ['https://fcm.googleapis.com/x'], new URL('https://fcm.googleapis.com/x'),
];

describe('push endpoints the server will send to', () => {
  it('accepts real FCM, APNs, Mozilla and Windows endpoints', () => {
    for (const url of VALID) expect(isPushEndpoint(url), url).toBe(true);
  });

  it('refuses the demonstrated metadata-address bypass', () => {
    const exploit = 'https://169.254.169.254;.fcm.googleapis.com/latest';
    // What made it dangerous: web-push would connect to the metadata address.
    expect(parseUrl(exploit).hostname).toBe('169.254.169.254');
    expect(isPushEndpoint(exploit)).toBe(false);
  });

  it('refuses every URL the two parsers could read two ways', () => {
    for (const url of PARSER_DISAGREEMENT) expect(isPushEndpoint(url), JSON.stringify(url)).toBe(false);
  });

  it('refuses localhost and private or metadata addresses in any spelling', () => {
    for (const url of LOCAL) expect(isPushEndpoint(url), url).toBe(false);
  });

  it('refuses hosts that are not exactly a push service', () => {
    for (const url of ELSEWHERE) expect(isPushEndpoint(url), url).toBe(false);
  });

  it('refuses malformed endpoints, other schemes, ports and credentials', () => {
    for (const value of MALFORMED) expect(isPushEndpoint(value), String(value)).toBe(false);
  });

  it('only ever accepts an endpoint whose host, as web-push reads it, is an allowed push service', () => {
    // Every printable ASCII character, and a few others, spliced in around an
    // allowed host: whatever gets through must connect to an allowed host.
    const chars = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '\t', '\n', '\r', '\u0000', 'é', '。'];
    const hosts = ['fcm.googleapis.com', 'web.push.apple.com'];
    let accepted = 0;
    for (const host of hosts) {
      for (const c of chars) {
        for (const url of [
          `https://169.254.169.254${c}.${host}/x`,
          `https://${host}${c}169.254.169.254/x`,
          `https://169.254.169.254${c}${host}/x`,
          `https://${host}${c}@169.254.169.254/x`,
          `https://${host}/${c}@169.254.169.254/x`,
          `https:${c}//${host}/x`,
          `https://${host}${c}/x`,
          `https://${c}${host}/x`,
        ]) {
          if (!isPushEndpoint(url)) continue;
          accepted++;
          const legacy = parseUrl(url);
          expect(isPushHost(legacy.hostname ?? ''), url).toBe(true);
          expect(legacy.port, url).toBeNull();
          expect(legacy.auth, url).toBeNull();
          expect(new URL(url).hostname, url).toBe(legacy.hostname);
        }
      }
    }
    // Plenty of these are ordinary paths ("/x" after "-", "~", ...), so the
    // check above is not vacuous.
    expect(accepted).toBeGreaterThan(20);
  });
});

describe.skipIf(!TEST_DB)('sending to a stored endpoint', () => {
  let userId: string;
  const requested: https.RequestOptions[] = [];

  beforeEach(async () => {
    await freshDatabase();
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    setPushSender(null); // the real web-push sender
    requested.length = 0;
    // No network: record where web-push would connect, and answer 201.
    vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback?: (res: unknown) => void) => {
      requested.push(options);
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; setTimeout: () => void };
      req.write = () => undefined;
      req.setTimeout = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
        res.statusCode = 201;
        res.headers = {};
        callback?.(res);
        res.emit('end');
      };
      return req;
    }) as unknown as typeof https.request);
    userId = (await createUser('Bob', 'bob@example.com')).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  const store = (endpoint: string) => getPool().query(
    `insert into app_push_subscription (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)`,
    [userId, endpoint, 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg'],
  );
  const payload = { title: 'AEROBOOK', body: 'test', url: '/', tag: 'test' };

  it('connects to the push service a valid endpoint names', async () => {
    await store(VALID[0]);
    expect(await pushToUser(userId, payload, 'topic')).toEqual({ sent: 1, devices: 1 });
    expect(requested.map((r) => r.hostname)).toEqual(['fcm.googleapis.com']);
  });

  it('never connects to an endpoint that got into the database some other way, and forgets it', async () => {
    // As if stored under the old, looser check.
    await store('https://169.254.169.254;.fcm.googleapis.com/latest');
    await store('https://localhost/x');
    expect(await pushToUser(userId, payload, 'topic')).toEqual({ sent: 0, devices: 2 });
    expect(requested).toEqual([]);
    expect((await getPool().query('select count(*)::int as n from app_push_subscription')).rows[0].n).toBe(0);
  });
});
