import React, { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { parseRoute, routeHash, type Me, type Route } from './lib/types';
import { Login, SetPassword } from './pages/Auth';
import { Candidates } from './pages/Candidates';
import { CandidateDetail } from './pages/CandidateDetail';
import { Usage } from './pages/Usage';
import { TeamPage } from './pages/Team';
import { Audit } from './pages/Audit';
import { Notice } from './components/ui';

// An invite, sign-in or reset link lands here with its type in the address;
// read it before the client consumes the link, to ask for a password.
const LINK_TYPE = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type');
const NEEDS_PASSWORD = LINK_TYPE === 'invite' || LINK_TYPE === 'recovery';

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsPassword, setNeedsPassword] = useState(NEEDS_PASSWORD);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true);
    });
    const onHash = () => setRoute(parseRoute(window.location.hash));
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
        displayName: data.display_name, orgName: (data as any).organizations?.name ?? 'Your organization',
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
      <div className="center-page"><div className="card auth-card stack">
        <h1>Not set up yet</h1>
        <Notice kind="info">{session.user.email} is signed in but is not part of an organization. Ask your PrepPilot admin to invite you.</Notice>
        <button className="btn" onClick={() => void supabase.auth.signOut()}>Sign out</button>
      </div></div>
    );
  }

  const nav: Array<{ route: Route; label: string; show: boolean }> = [
    { route: { page: 'candidates' }, label: 'Candidates', show: true },
    { route: { page: 'usage' }, label: 'Usage & cost', show: true },
    { route: { page: 'team' }, label: 'Teams & staff', show: true },
    { route: { page: 'audit' }, label: 'Audit log', show: me.role === 'admin' },
  ];
  const activePage = route.page === 'candidate' ? 'candidates' : route.page;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main">
        <div className="brand">PrepPilot<small>{me.orgName}</small></div>
        {nav.filter((n) => n.show).map((n) => (
          <a key={n.label} href={routeHash(n.route)} className={`nav-item ${activePage === n.route.page ? 'active' : ''}`}>{n.label}</a>
        ))}
        <div className="sidebar-foot stack">
          <span>{me.displayName ?? me.email}<br />{me.role}</span>
          <button className="btn small" onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {route.page === 'candidates' && <Candidates me={me} go={go} />}
        {route.page === 'candidate' && <CandidateDetail me={me} id={route.id} go={go} />}
        {route.page === 'usage' && <Usage />}
        {route.page === 'team' && <TeamPage me={me} />}
        {route.page === 'audit' && me.role === 'admin' && <Audit />}
      </main>
    </div>
  );
};
