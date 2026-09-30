import { describe, expect, it } from 'vitest';
import { alertsFor, chatTime, IDLE_MS, pollDelay, viewFor } from './inbox';

describe('where the person is looking', () => {
  it('names the conversation or aircraft on screen', () => {
    expect(viewFor('/chat/cv_abc')).toBe('conv:cv_abc');
    expect(viewFor('/aircraft/air_1')).toBe('aircraft:air_1');
    expect(viewFor('/aircraft/a%2Fb')).toBe('aircraft:a/b');
    expect(viewFor('/chat')).toBe('app');
    expect(viewFor('/aircraft')).toBe('app');
    expect(viewFor('/')).toBe('app');
  });
});

describe('how often to check', () => {
  it('is quick in a conversation, slower elsewhere, slow when idle, and stops in the background', () => {
    expect(pollDelay({ hidden: false, view: 'conv:x', idleFor: 0 })).toBe(3000);
    expect(pollDelay({ hidden: false, view: 'app', idleFor: 0 })).toBe(8000);
    expect(pollDelay({ hidden: false, view: 'conv:x', idleFor: IDLE_MS + 1 })).toBe(30000);
    expect(pollDelay({ hidden: true, view: 'conv:x', idleFor: 0 })).toBeNull();
  });
});

describe('which events pop up', () => {
  const event = (id: number, thread: string) => ({ id, thread, url: '/', text: 't' });

  it('pops up each event once, and never for the thread on screen', () => {
    const shown = new Set<number>();
    expect(alertsFor([event(1, 'conv:a'), event(2, 'conv:b')], 'conv:b', shown).map((e) => e.id)).toEqual([1]);
    expect(alertsFor([event(1, 'conv:a'), event(2, 'conv:b'), event(3, 'aircraft:x')], 'app', shown).map((e) => e.id)).toEqual([3]);
  });
});

describe('chat times', () => {
  const now = new Date(2026, 8, 30, 15, 0);
  it('says the time today, and the day before that', () => {
    expect(chatTime(new Date(2026, 8, 30, 9, 5).toISOString(), now)).not.toMatch(/Yesterday/);
    expect(chatTime(new Date(2026, 8, 29, 9, 5).toISOString(), now)).toMatch(/^Yesterday /);
    expect(chatTime(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toMatch(/Sep|1/);
    expect(chatTime('nonsense', now)).toBe('');
  });
});
