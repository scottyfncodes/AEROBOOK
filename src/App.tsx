import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { ToastProvider, useToast } from './components/ui';
import { IntroSplash, Splash } from './components/Brand';
import { IconBell, IconChat, IconHome, IconPlane, IconSettings, IconUsers } from './components/Icons';
import { useDatabase, useLoaded, useSaveError } from './data/useStore';
import { onNotice } from './data/store';
import { SessionProvider, useSession } from './data/session';
import { InboxProvider, useInbox } from './data/inbox';

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
import SignIn from './screens/SignIn';
import History from './screens/History';
import Chat from './screens/Chat';
import Conversation from './screens/Conversation';

/**
 * Six tabs: five places records live, and Chat. Opportunities, Prospects, Templates,
 * Import and Tools are reachable from the screens they belong to (Home, an
 * aircraft, a contact, Settings) rather than taking a tab of their own.
 * Every tab always returns to that section's top rather than toggling.
 */
const TABS = [
  { to: '/', label: 'Home', Icon: IconHome, end: true, ariaLabel: 'AEROBOOK Home' },
  { to: '/aircraft', label: 'Aircraft', Icon: IconPlane, end: false },
  { to: '/contacts', label: 'Contacts', Icon: IconUsers, end: false },
  { to: '/follow-ups', label: 'Follow-up', Icon: IconBell, end: false },
  { to: '/chat', label: 'Chat', Icon: IconChat, end: false },
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

/** Things that happened elsewhere — someone else's edit winning, say — arrive as toasts. */
function Notices() {
  const toast = useToast();
  useEffect(() => onNotice(toast), [toast]);
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
  return (
    <ToastProvider>
      <SessionProvider>
        <Gate />
        <IntroSplash />
      </SessionProvider>
    </ToastProvider>
  );
}

/** Nothing but the sign-in screen until someone is signed in and their data is open. */
function Gate() {
  const { status } = useSession();
  return status === 'ready' ? <Shell /> : <SignIn />;
}

function Shell() {
  const loaded = useLoaded();
  const navigate = useNavigate();
  const { pathname } = useLocation();

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
    <InboxProvider>
      <Notices />
      <ThemeSync />
      <ScrollToTop />
      <div className={`app${/^\/chat\/[^/]+/.test(pathname) ? ' app--conversation' : ''}`}>
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
            <Route path="/history" element={<History />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/chat/:id" element={<Conversation />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        ) : (
          <Splash />
        )}

        <TabBar />
      </div>
    </InboxProvider>
  );
}

/** Fields that bring up a phone's keyboard. */
function typesText(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement
    && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type);
}

/**
 * The tabs, with Chat's unread count on its icon.
 *
 * iOS leaves a fixed bar wherever the bottom of the screen was while the
 * keyboard was up, so after typing in Settings it floated mid-page until the
 * next scroll. The bar steps aside while someone types (as native tab bars
 * do), and follows the bottom of what is actually on screen otherwise.
 */
function TabBar() {
  const { chatUnread } = useInbox();
  const [typing, setTyping] = useState(false);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    let blur: ReturnType<typeof setTimeout> | undefined;
    // Only where typing brings up an on-screen keyboard.
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const onFocusIn = (e: FocusEvent) => {
      if (!typesText(e.target)) return;
      clearTimeout(blur);
      setTyping(true);
    };
    // Moving from one field to the next keeps the keyboard up; wait to see.
    const onFocusOut = () => {
      clearTimeout(blur);
      blur = setTimeout(() => setTyping(typesText(document.activeElement)), 100);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      clearTimeout(blur);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const pin = () => {
      // How far the bottom of what is on screen sits from where the page thinks it is.
      const off = Math.round(vv.height + vv.offsetTop - window.innerHeight);
      nav.current?.style.setProperty('transform', off ? `translateY(${off}px)` : '');
    };
    pin();
    vv.addEventListener('resize', pin);
    vv.addEventListener('scroll', pin);
    return () => {
      vv.removeEventListener('resize', pin);
      vv.removeEventListener('scroll', pin);
    };
  }, []);

  return (
    <nav ref={nav} className={`tabbar${typing ? ' tabbar--typing' : ''}`} aria-label="Main">
      {TABS.map(({ to, label, Icon, end, ariaLabel }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={ariaLabel}
          className={({ isActive }) => `tabbar__item${isActive ? ' is-active' : ''}`}
        >
          <span className="tabbar__icon">
            <Icon aria-hidden />
            {to === '/chat' && chatUnread > 0 ? (
              <span className="tabbar__badge" aria-label={`${chatUnread} unread`}>{chatUnread > 99 ? '99+' : chatUnread}</span>
            ) : null}
          </span>
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
