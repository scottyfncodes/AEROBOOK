import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import {
  IconBell, IconDoc, IconMail, IconMap, IconPlane, IconPlus, IconSearch, IconTarget, IconUpload, IconUsers,
} from '../components/Icons';
import { Chip, EmptyState, Metric } from '../components/ui';
import { Colophon } from '../components/Brand';
import { useDatabase } from '../data/useStore';
import {
  bucketFollowUps, followUpSubject, openFollowUps, pipeline, recentlyContacted, recentlyUpdated,
} from '../lib/selectors';
import { formatDate, relativeDue } from '../lib/dates';
import { displayName } from '../lib/names';

export default function Home() {
  const db = useDatabase();
  const buckets = bucketFollowUps(openFollowUps(db));
  const pipe = pipeline(db);
  const hasData = db.contacts.length > 0 || db.aircraft.length > 0;

  const lastImport = db.imports[0];
  const recentAircraft = recentlyUpdated(db.aircraft, 4);
  const recentContacts = recentlyContacted(db, 4);

  return (
    <>
      <AppBar wordmark />
      <main className="page stack stack--lg">
        <section aria-label="Quick actions">
          <div className="quick-actions">
            <Link className="quick-action quick-action--primary" to="/import">
              <IconUpload aria-hidden />
              Import CSV
            </Link>
            <Link className="quick-action" to="/contacts?new=1">
              <IconPlus aria-hidden />
              Contact
            </Link>
            <Link className="quick-action" to="/aircraft?new=1">
              <IconPlane aria-hidden />
              Aircraft
            </Link>
            <Link className="quick-action" to="/follow-ups">
              <IconBell aria-hidden />
              Follow-ups
            </Link>
            <Link className="quick-action" to="/search">
              <IconSearch aria-hidden />
              Search
            </Link>
            <Link className="quick-action" to="/opportunities?new=1">
              <IconTarget aria-hidden />
              Opportunity
            </Link>
            <Link className="quick-action" to="/templates">
              <IconMail aria-hidden />
              Email
            </Link>
            <Link className="quick-action" to="/layover">
              <IconMap aria-hidden />
              Layover
            </Link>
          </div>
        </section>

        {!hasData ? (
          <section className="card">
            <EmptyState
              icon={<IconPlane />}
              title="Nothing in the book yet"
              body="Import an aircraft-owner list and AEROBOOK will build the contacts, the aircraft and the link between them."
              action={<Link className="btn btn--primary" to="/import">Import a CSV</Link>}
            />
          </section>
        ) : null}

        <section className="stack stack--sm" aria-label="Follow-ups">
          <div className="row row--between">
            <h2 className="section-title">Follow-ups</h2>
            <Link className="small" to="/follow-ups">All</Link>
          </div>
          {buckets.overdue.length + buckets.today.length + buckets.upcoming.length === 0 ? (
            <div className="card small muted">Nothing due. Set a follow-up from any contact or aircraft.</div>
          ) : (
            <>
              <div className="card">
                <div className="metric-grid">
                  <Metric value={buckets.overdue.length} label="Overdue" tone={buckets.overdue.length ? 'danger' : undefined} />
                  <Metric value={buckets.today.length} label="Today" tone={buckets.today.length ? 'warn' : undefined} />
                  <Metric value={buckets.upcoming.length} label="Upcoming" />
                </div>
              </div>
              <div className="list">
                {[...buckets.overdue, ...buckets.today].slice(0, 4).map((f) => (
                  <Link key={f.id} className="tile" to="/follow-ups">
                    <div className="row row--between">
                      <span className="strong truncate">{followUpSubject(db, f)}</span>
                      <Chip tone={f.dueDate < new Date().toISOString().slice(0, 10) ? 'danger' : 'warn'}>
                        {relativeDue(f.dueDate)}
                      </Chip>
                    </div>
                    <div className="small muted truncate">{f.note || 'Follow up'}</div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>

        {hasData ? (
          <section className="stack stack--sm" aria-label="Pipeline">
            <h2 className="section-title">Pipeline</h2>
            <div className="card">
              <div className="metric-grid">
                <Metric value={pipe.newProspects} label="New" />
                <Metric value={pipe.active} label="Active" />
                <Metric value={pipe.quotes} label="Quotes" tone={pipe.quotes ? 'accent' : undefined} />
                <Metric value={pipe.clients} label="Clients" tone={pipe.clients ? 'success' : undefined} />
                <Metric value={pipe.aircraftOpportunities} label="Aircraft" />
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn--sm grow" to="/prospects">Prospects</Link>
              <Link className="btn btn--sm grow" to="/opportunities">Opportunities</Link>
            </div>
          </section>
        ) : null}

        {hasData ? (
          <section className="stack stack--sm" aria-label="Book">
            <h2 className="section-title">The book</h2>
            <div className="row" style={{ gap: 8 }}>
              <Link className="tile grow" to="/aircraft">
                <div className="row">
                  <IconPlane className="muted" style={{ width: 18, height: 18 }} />
                  <div className="grow">
                    <div className="strong numeric">{db.aircraft.length}</div>
                    <div className="xsmall muted">Aircraft</div>
                  </div>
                </div>
              </Link>
              <Link className="tile grow" to="/contacts">
                <div className="row">
                  <IconUsers className="muted" style={{ width: 18, height: 18 }} />
                  <div className="grow">
                    <div className="strong numeric">{db.contacts.length}</div>
                    <div className="xsmall muted">Contacts</div>
                  </div>
                </div>
              </Link>
            </div>
          </section>
        ) : null}

        {recentContacts.length > 0 ? (
          <section className="stack stack--sm" aria-label="Recently contacted">
            <h2 className="section-title">Recently contacted</h2>
            <div className="list list--flush">
              {recentContacts.map((c) => (
                <Link key={c.id} className="link-row" to={`/contacts/${c.id}`}>
                  <span className="grow truncate">{displayName(c)}</span>
                  <span className="xsmall muted nowrap">{relativeDue(c.lastContactedAt ?? '')}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {recentAircraft.length > 0 ? (
          <section className="stack stack--sm" aria-label="Recently updated aircraft">
            <h2 className="section-title">Recently updated</h2>
            <div className="list list--flush">
              {recentAircraft.map((a) => (
                <Link key={a.id} className="link-row" to={`/aircraft/${a.id}`}>
                  <span className="tail">{a.tailNumber}</span>
                  <span className="grow small muted truncate">{[a.year, a.make, a.model].filter(Boolean).join(' ')}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {lastImport ? (
          <section className="stack stack--sm" aria-label="Last import">
            <h2 className="section-title">Last import</h2>
            <Link className="tile" to="/import/history">
              <div className="row row--between">
                <span className="truncate">{lastImport.filename}</span>
                <span className="xsmall muted nowrap">{formatDate(lastImport.date)}</span>
              </div>
              <div className="small muted">
                {lastImport.contactsCreated} contacts · {lastImport.aircraftCreated} aircraft created
              </div>
            </Link>
          </section>
        ) : null}

        <section className="row" style={{ gap: 8 }}>
          <Link className="btn btn--sm btn--ghost grow" to="/settings">
            <IconDoc /> Settings &amp; export
          </Link>
        </section>

        <Colophon />
      </main>
    </>
  );
}
