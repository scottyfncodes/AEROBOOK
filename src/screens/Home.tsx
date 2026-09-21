/**
 * The home screen answers one question: what needs my attention?
 *
 * Everything above the fold is something the user can act on today. Counts
 * that cannot be acted on — total contacts, total aircraft — sit below the
 * work, because a number nobody acts on is decoration.
 */
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import {
  IconBell, IconDoc, IconMail, IconPlane, IconPlus, IconShield, IconTarget,
  IconUpload, IconUsers,
} from '../components/Icons';
import { Chip, EmptyState, Metric } from '../components/ui';
import { PolicyRow } from '../components/insurance';
import { Colophon } from '../components/Brand';
import { useDatabase } from '../data/useStore';
import {
  bucketFollowUps, followUpSubject, openFollowUps, openOpportunities, pipeline, recentActivity,
} from '../lib/selectors';
import { renewalSummary, renewalsNeedingAttention } from '../lib/insurance';
import { formatDate, formatDateTime, relativeDue } from '../lib/dates';
import { displayName } from '../lib/names';

export default function Home() {
  const db = useDatabase();
  const buckets = bucketFollowUps(openFollowUps(db));
  const pipe = pipeline(db);
  const renewals = renewalsNeedingAttention(db);
  const renewalCounts = renewalSummary(db);
  const hasData = db.contacts.length > 0 || db.aircraft.length > 0;

  const today = [...buckets.overdue, ...buckets.today];
  const openDeals = openOpportunities(db);
  const recent = recentActivity(db, 5);
  const lastImport = db.imports[0];

  return (
    <>
      <AppBar wordmark />
      <main className="page stack stack--lg">
        <div className="stack stack--sm">
          {/* The header already carries a search icon on every screen, so this
              row is for the actions search cannot do: creating something. */}
          <section aria-label="Quick actions">
            <div className="quick-actions">
              <Link className="quick-action" to="/contacts?new=1">
                <IconPlus aria-hidden />
                Contact
              </Link>
              <Link className="quick-action" to="/aircraft?new=1">
                <IconPlane aria-hidden />
                Aircraft
              </Link>
              <Link className="quick-action" to="/opportunities?new=1">
                <IconTarget aria-hidden />
                Opportunity
              </Link>
              <Link className="quick-action quick-action--primary" to="/follow-ups?new=1">
                <IconBell aria-hidden />
                Follow-up
              </Link>
              <Link className="quick-action" to="/import">
                <IconUpload aria-hidden />
                Import CSV
              </Link>
              <Link className="quick-action" to="/templates">
                <IconMail aria-hidden />
                Templates
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
        </div>

        {/* ------------------------------------------------------- today */}
        <section className="stack stack--sm" aria-label="Today">
          <div className="row row--between">
            <h2 className="section-title">Today</h2>
            <Link className="small" to="/follow-ups">All follow-ups</Link>
          </div>

          <div className="card">
            <div className="metric-grid metric-grid--quad">
              <Metric value={buckets.overdue.length} label="Overdue" tone={buckets.overdue.length ? 'danger' : undefined} />
              <Metric value={buckets.today.length} label="Due today" tone={buckets.today.length ? 'warn' : undefined} />
              <Metric value={buckets.upcoming.length} label="This week" />
              <Metric
                value={renewalCounts.expired + renewalCounts.upcoming}
                label="Renewals"
                tone={renewalCounts.expired ? 'danger' : renewalCounts.upcoming ? 'warn' : undefined}
              />
            </div>
          </div>

          {today.length === 0 ? (
            <div className="card small muted">
              Nothing due today. Set a follow-up from any contact, aircraft or opportunity.
            </div>
          ) : (
            <div className="list">
              {today.slice(0, 6).map((f) => (
                <Link
                  key={f.id}
                  className="tile"
                  to={f.aircraftId ? `/aircraft/${f.aircraftId}` : f.contactId ? `/contacts/${f.contactId}` : '/follow-ups'}
                >
                  <div className="row row--between">
                    <span className="strong truncate">{followUpSubject(db, f)}</span>
                    <Chip tone={buckets.overdue.includes(f) ? 'danger' : 'warn'}>{relativeDue(f.dueDate)}</Chip>
                  </div>
                  <div className="small secondary truncate">{f.note || 'Follow up'}</div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* --------------------------------------------------- insurance */}
        {renewals.length > 0 ? (
          <section className="stack stack--sm" aria-label="Insurance renewals">
            <h2 className="section-title">Insurance</h2>
            <div className="list">
              {renewals.slice(0, 5).map(({ policy, aircraft, contact }) => (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  title={aircraft?.tailNumber ?? (contact ? displayName(contact) : 'Policy')}
                  subtitle={contact ? displayName(contact) : undefined}
                  to={aircraft ? `/aircraft/${aircraft.id}` : contact ? `/contacts/${contact.id}` : '/aircraft'}
                />
              ))}
            </div>
            {renewals.length > 5 ? (
              <div className="small muted">{renewals.length - 5} more want attention.</div>
            ) : null}
          </section>
        ) : null}

        {/* ---------------------------------------------- active business */}
        {hasData ? (
          <section className="stack stack--sm" aria-label="Active business">
            <div className="row row--between">
              <h2 className="section-title">Active business</h2>
              <Link className="small" to="/opportunities">Pipeline</Link>
            </div>

            {openDeals.length === 0 ? (
              <div className="card small muted">
                No open opportunities. Create one from any contact or aircraft.
              </div>
            ) : (
              <div className="list">
                {openDeals.slice(0, 4).map((o) => {
                  const aircraft = o.aircraftId ? db.aircraft.find((a) => a.id === o.aircraftId) : undefined;
                  const contact = o.contactId ? db.contacts.find((c) => c.id === o.contactId) : undefined;
                  return (
                    <Link key={o.id} className="tile" to={`/opportunities/${o.id}`}>
                      <div className="row row--between">
                        <span className="strong truncate">{o.title || `${o.type} opportunity`}</span>
                        <Chip tone="accent">{o.status}</Chip>
                      </div>
                      <div className="small muted truncate">
                        {[o.type, contact ? displayName(contact) : '', aircraft?.tailNumber].filter(Boolean).join(' · ')}
                      </div>
                      {o.nextAction ? <div className="small secondary truncate">Next: {o.nextAction}</div> : null}
                    </Link>
                  );
                })}
              </div>
            )}

            {pipe.forSale + pipe.wanted > 0 ? (
              <div className="row" style={{ gap: 8 }}>
                {pipe.forSale > 0 ? (
                  <Link className="tile grow" to="/aircraft">
                    <div className="strong numeric">{pipe.forSale}</div>
                    <div className="xsmall muted">For sale</div>
                  </Link>
                ) : null}
                {pipe.wanted > 0 ? (
                  <Link className="tile grow" to="/aircraft">
                    <div className="strong numeric">{pipe.wanted}</div>
                    <div className="xsmall muted">Purchase prospects</div>
                  </Link>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ------------------------------------------------------- recent */}
        {recent.length > 0 ? (
          <section className="stack stack--sm" aria-label="Recent activity">
            <h2 className="section-title">Recent</h2>
            <div className="list list--flush">
              {recent.map((a) => {
                const to = a.opportunityId
                  ? `/opportunities/${a.opportunityId}`
                  : a.aircraftId
                    ? `/aircraft/${a.aircraftId}`
                    : a.contactId
                      ? `/contacts/${a.contactId}`
                      : '/';
                return (
                  <Link key={a.id} className="link-row" to={to}>
                    <div className="grow">
                      <div className="small truncate">{a.subject || a.type}</div>
                      <div className="xsmall muted truncate">{a.type}</div>
                    </div>
                    <span className="xsmall muted nowrap">{formatDateTime(a.date) || formatDate(a.date)}</span>
                  </Link>
                );
              })}
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
              <Link className="tile grow" to="/opportunities">
                <div className="row">
                  <IconShield className="muted" style={{ width: 18, height: 18 }} />
                  <div className="grow">
                    <div className="strong numeric">{db.policies.length}</div>
                    <div className="xsmall muted">Policies</div>
                  </div>
                </div>
              </Link>
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
