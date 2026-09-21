import { useEffect } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { ToastProvider } from './components/ui';
import { Mark } from './components/Brand';
import { IconBell, IconPlane, IconSettings, IconUsers } from './components/Icons';
import { useDatabase, useLoaded, useSaveError } from './data/useStore';

import Home from './screens/Home';
import Contacts from './screens/Contacts';
import ContactDetail from './screens/ContactDetail';
import AircraftList from './screens/AircraftList';
import AircraftDetail from './screens/AircraftDetail';
import Prospects from './screens/Prospects';
import Opportunities from './screens/Opportunities';
import OpportunityDetail from './screens/OpportunityDetail';
import FollowUps from './screens/FollowUps';
import Import from './screens/Import';
import ImportHistory from './screens/ImportHistory';
import SearchScreen from './screens/Search';
import Tools from './screens/Tools';
import Templates from './screens/Templates';
import Settings from './screens/Settings';
import NotFound from './screens/NotFound';

/**
 * Five tabs, each a place records live. Opportunities, Prospects, Templates,
 * Import and Tools are reachable from the screens they belong to (Home, an
 * aircraft, a contact, Settings) rather than taking a tab of their own.
 * Every tab always returns to that section's top rather than toggling.
 */
const TABS = [
  { to: '/', label: 'Home', Icon: IconPlane, end: true, ariaLabel: 'AEROBOOK Home' },
  { to: '/aircraft', label: 'Aircraft', Icon: IconPlane, end: false },
  { to: '/contacts', label: 'Contacts', Icon: IconUsers, end: false },
  { to: '/follow-ups', label: 'Follow-ups', Icon: IconBell, end: false },
  { to: '/settings', label: 'Settings', Icon: IconSettings, end: false },
];

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

/** Applies the stored theme preference to the document. */
function ThemeSync() {
  const db = useDatabase();
  useEffect(() => {
    const root = document.documentElement;
    if (db.settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', db.settings.theme);
  }, [db.settings.theme]);
  return null;
}

function SaveErrorBanner() {
  const error = useSaveError();
  if (!error) return null;
  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="banner banner--danger">
        <div>
          <strong>Changes are not being saved.</strong> {error} Export your data from Settings before closing the app.
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const loaded = useLoaded();
  const navigate = useNavigate();

  // Cmd/Ctrl-K opens search, the way every tool the user already has does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate('/search');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <ToastProvider>
      <ThemeSync />
      <ScrollToTop />
      <div className="app">
        <SaveErrorBanner />
        {loaded ? (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<SearchScreen />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/contacts/:id" element={<ContactDetail />} />
            <Route path="/aircraft" element={<AircraftList />} />
            <Route path="/aircraft/:id" element={<AircraftDetail />} />
            <Route path="/prospects" element={<Prospects />} />
            <Route path="/opportunities" element={<Opportunities />} />
            <Route path="/opportunities/:id" element={<OpportunityDetail />} />
            <Route path="/follow-ups" element={<FollowUps />} />
            <Route path="/import" element={<Import />} />
            <Route path="/import/history" element={<ImportHistory />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        ) : (
          <div className="page">
            <div className="splash">
              <Mark size={44} />
              <span className="splash__wordmark">AEROBOOK</span>
            </div>
          </div>
        )}

        <nav className="tabbar" aria-label="Main">
          {TABS.map(({ to, label, Icon, end, ariaLabel }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={ariaLabel}
              className={({ isActive }) => `tabbar__item${isActive ? ' is-active' : ''}`}
            >
              <Icon aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
