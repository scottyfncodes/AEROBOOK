import { describe, expect, it } from 'vitest';
import { AircraftIndex, ContactIndex, diffFields } from './matching';
import type { Aircraft, Contact } from '../data/types';

function contact(patch: Partial<Contact>): Contact {
  return {
    id: 'c1', firstName: '', lastName: '', rawName: '', company: '', email: '', phone: '',
    address: '', city: '', state: '', zip: '', contactTypes: [], status: 'Prospect',
    prospectStatus: 'New', notes: '', custom: {}, nameConfidence: 'high', needsReview: false,
    createdAt: '', updatedAt: '', ...patch,
  };
}

function aircraft(patch: Partial<Aircraft> & { tailNumber: string; tailKey: string }): Aircraft {
  return {
    id: 'a1', year: '', make: '', model: '', ownerships: [], status: 'Unknown', notes: '',
    custom: {}, createdAt: '', updatedAt: '', ...patch,
  };
}

describe('ContactIndex', () => {
  const existing = [
    contact({ id: 'c1', firstName: 'John', lastName: 'Heine', email: 'JHEINE@acentech.com', phone: '7818917648', address: '1308 Santa Teresita Dr', zip: '931051947' }),
    contact({ id: 'c2', firstName: 'Marlon', lastName: 'Humphrey', address: '4209 Woodbine Ln', zip: '35226' }),
  ];
  const index = new ContactIndex(existing);

  it('matches on email regardless of case', () => {
    const m = index.find({ email: 'jheine@ACENTECH.COM' });
    expect(m.contact?.id).toBe('c1');
    expect(m.reason).toBe('email');
  });

  it('matches on phone regardless of formatting', () => {
    const m = index.find({ phone: '+1 (781) 891-7648' });
    expect(m.contact?.id).toBe('c1');
    expect(m.reason).toBe('phone');
  });

  it('matches on name plus address when there is no email or phone', () => {
    const m = index.find({ firstName: 'Marlon', lastName: 'Humphrey', address: '4209 Woodbine Lane' });
    expect(m.contact?.id).toBe('c2');
    expect(m.reason).toBe('name+address');
  });

  it('matches on name plus ZIP as a last resort', () => {
    const m = index.find({ firstName: 'Marlon', lastName: 'Humphrey', address: 'somewhere else', zip: '35226' });
    expect(m.contact?.id).toBe('c2');
    expect(m.reason).toBe('name+zip');
  });

  it('does not match a different person at the same address', () => {
    expect(index.find({ firstName: 'Sarah', lastName: 'Humphrey', address: '4209 Woodbine Ln' }).contact).toBeNull();
  });

  it('does not match on nothing', () => {
    expect(index.find({}).contact).toBeNull();
    expect(index.find({ email: '', phone: '' }).contact).toBeNull();
  });

  it('ignores a phone number that is too short to be meaningful', () => {
    expect(index.find({ phone: '1234' }).contact).toBeNull();
  });
});

describe('AircraftIndex', () => {
  const index = new AircraftIndex([aircraft({ id: 'a1', tailNumber: 'N917JH', tailKey: '917JH' })]);

  it('matches on a normalised tail', () => {
    expect(index.find('n917jh').aircraft?.id).toBe('a1');
    expect(index.find('N-917-JH').aircraft?.id).toBe('a1');
    expect(index.find('917JH').aircraft?.id).toBe('a1');
    expect(index.find('N917JH').reason).toBe('tail');
  });

  it('does not match an empty or different tail', () => {
    expect(index.find('').aircraft).toBeNull();
    expect(index.find('N441FP').aircraft).toBeNull();
  });
});

describe('diffFields', () => {
  const labels = { email: 'Email', phone: 'Phone' };

  it('reports a filled-in blank as new information', () => {
    const changes = diffFields({ email: '', phone: '555' }, { email: 'a@b.com' }, labels);
    expect(changes).toHaveLength(1);
    expect(changes[0].isNewInformation).toBe(true);
  });

  it('reports a genuine conflict', () => {
    const changes = diffFields({ email: 'old@b.com' }, { email: 'new@b.com' }, labels);
    expect(changes[0].isNewInformation).toBe(false);
    expect(changes[0].existing).toBe('old@b.com');
    expect(changes[0].incoming).toBe('new@b.com');
  });

  it('ignores blank incoming values so an import cannot erase data', () => {
    expect(diffFields({ email: 'a@b.com' }, { email: '', phone: undefined }, labels)).toEqual([]);
  });

  it('ignores case-only differences', () => {
    expect(diffFields({ email: 'A@B.com' }, { email: 'a@b.com' }, labels)).toEqual([]);
  });
});
