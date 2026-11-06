import React, { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { BarChart3, ChevronRight, LogOut, ScrollText, Users, UsersRound } from 'lucide-react';
import { supabase } from './supabase';
import { parseRoute, routeHash, type Me, type Route } from './lib/types';
import { Login, SetPassword } from './pages/Auth';
import { Candidates } from './pages/Candidates';
import { CandidateDetail } from './pages/CandidateDetail';
import { Usage } from './pages/Usage';
import { TeamPage } from './pages/Team';
import { Audit } from './pages/Audit';
import { Alert, Avatar, ToastProvider } from './components/ui';

// An invite, sign-in or reset link lands here with its type in the address;
// read it before the client consumes the link, to ask for a password.
const LINK_TYPE = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type');
const NEEDS_PASSWORD = LINK_TYPE === 'invite' || LINK_TYPE === 'recovery';

const NAV = [
  { page: 'candidates' as const, label: 'Candidates', icon: Users },
  { page: 'usage' as const, label: 'Usage & cost', icon: BarChart3 },
  { page: 'team' as const, label: 'Teams & staff', icon: UsersRound },
  { page: 'audit' as const, label: 'Audit log', icon: ScrollText, adminOnly: true },
];

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsPassword, setNeedsPassword] = useState(NEEDS_PASSWORD);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [crumb, setCrumb] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    const onHash = () => { setRoute(parseRoute(window.location.hash)); setCrumb(null); };
    window.addEventListener('hashchange', onHash);
    return () => { data.subscription.unsubscribe(); window.removeEventListener('hashchange', onHash); };
  }, []);

  useEffect(() => {
    if (!session) { setMe(session === null ? null : undefined); return; }
    let live = true;
    void (async () => {
      const { data } = await supabase.from('staff').select('org_id, role, display_name, organizations(name)').eq('user_id', session.user.id).maybeSingle();
      if (!live) return;
      setMe(data ? {
        userId: session.user.id, email: session.user.email ?? null, orgId: data.org_id, role: data.role,
        displayName: data.display_name, orgName: (data as { organizations?: { name?: string } }).organizations?.name ?? 'Your organization',
      } : null);
    })();
    return () => { live = false; };
  }, [session]);

  const go = useCallback((r: Route) => { window.location.hash = routeHash(r); }, []);

  if (session === undefined) return null;
  if (!session) return <Login />;
  if (needsPassword) return <SetPassword onDone={() => { setNeedsPassword(false); go({ page: 'candidates' }); }} />;
  if (me === undefined) return null;
  if (me === null) {
    return (
      <div className="auth"><div className="auth-card stack" style={{ gap: 16 }}>
        <div className="auth-word">PrepPilot</div>
        <Alert kind="info">{session.user.email} is signed in but is not part of an organization. Ask your PrepPilot admin to invite you.</Alert>
        <button className="btn btn-lg" onClick={() => void supabase.auth.signOut()}><LogOut size={14} /> Sign out</button>
      </div></div>
    );
  }

  const active = route.page === 'candidate' ? 'candidates' : route.page;
  const who = me.displayName ?? me.email ?? 'You';

  return (
    <ToastProvider>
      <div className="shell">
        <aside className="sidebar" aria-label="Main">
          <div className="wordmark">PrepPilot</div>
          <div className="org-line">{me.orgName} · Manager</div>
          <nav className="nav">
            {NAV.filter((n) => !n.adminOnly || me.role === 'admin').map(({ page, label, icon: Icon }) => (
              <a key={page} href={routeHash({ page } as Route)} className={`nav-item ${active === page ? 'active' : ''}`} aria-current={active === page ? 'page' : undefined}>
                <Icon size={16} strokeWidth={1.75} />{label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="me">
              <Avatar name={who} />
              <div className="who"><div className="name" title={me.email ?? ''}>{who}</div><div className="role">{me.role}</div></div>
            </div>
            <button className="signout" onClick={() => void supabase.auth.signOut()}><LogOut size={16} strokeWidth={1.75} /> Sign out</button>
          </div>
        </aside>
        <main className="main">
          <div className="page">
            {route.page === 'candidate' && (
              <nav className="crumbs" aria-label="Breadcrumb">
                <a href="#/candidates">Candidates</a><ChevronRight size={13} /><span>{crumb ?? 'Candidate'}</span>
              </nav>
            )}
            {route.page === 'candidates' && <Candidates me={me} go={go} />}
            {route.page === 'candidate' && <CandidateDetail me={me} id={route.id} go={go} onName={setCrumb} />}
            {route.page === 'usage' && <Usage />}
            {route.page === 'team' && <TeamPage me={me} />}
            {route.page === 'audit' && me.role === 'admin' && <Audit />}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
};
