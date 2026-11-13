import React, { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { BarChart3, Building2, CalendarCheck, ChevronRight, LogOut, ScrollText, Users, UsersRound } from 'lucide-react';
import { supabase } from './supabase';
import { ROLE_LABEL, isAdmin, parseRoute, routeHash, type Me, type Route } from './lib/types';
import { Login, SetPassword } from './pages/Auth';
import { Candidates } from './pages/Candidates';
import { CandidateDetail } from './pages/CandidateDetail';
import { Interviews } from './pages/Interviews';
import { Usage } from './pages/Usage';
import { TeamPage } from './pages/Team';
import { Audit } from './pages/Audit';
import { Companies } from './pages/Companies';
import { Alert, Avatar, ToastProvider } from './components/ui';

// An invite, sign-in or reset link lands here with its type in the address;
// read it before the client consumes the link, to ask for a password.
const LINK_TYPE = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type');
const NEEDS_PASSWORD = LINK_TYPE === 'invite' || LINK_TYPE === 'recovery';

const NAV: Array<{ page: Route['page']; label: string; icon: typeof Users; show?: (me: Me) => boolean }> = [
  { page: 'candidates', label: 'Candidates', icon: Users },
  { page: 'interviews', label: 'Interviews', icon: CalendarCheck },
  { page: 'usage', label: 'Usage & cost', icon: BarChart3 },
  { page: 'team', label: 'Teams & staff', icon: UsersRound },
  { page: 'audit', label: 'Audit log', icon: ScrollText, show: isAdmin },
  { page: 'companies', label: 'Companies', icon: Building2, show: (me) => me.isOwner },
];

interface WhoAmI { is_owner: boolean; role: Me['role'] | null; org_id: string | null; org_name: string | null; require_slots: boolean | null; display_name: string | null }

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsPassword, setNeedsPassword] = useState(NEEDS_PASSWORD);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [crumb, setCrumb] = useState<string | null>(null);
  const [meVersion, setMeVersion] = useState(0);
  // An owner switching company, or a setting changing: read who we are again.
  const reloadMe = useCallback(() => setMeVersion((v) => v + 1), []);

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
      const { data } = await supabase.rpc('pp_whoami');
      if (!live) return;
      const w = data as WhoAmI | null;
      if (!w || (!w.is_owner && !w.org_id) || !w.role) { setMe(null); return; }
      setMe({
        userId: session.user.id, email: session.user.email ?? null,
        orgId: w.org_id ?? '', orgName: w.org_name ?? '', role: w.role, isOwner: w.is_owner,
        displayName: w.display_name, requireSlots: Boolean(w.require_slots),
      });
    })();
    return () => { live = false; };
  }, [session, meVersion]);

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

  // An owner who has not picked a company yet works on the Companies page only.
  const noCompany = me.isOwner && !me.orgId;
  const page: Route['page'] = noCompany ? 'companies' : route.page;
  const active = page === 'candidate' ? 'candidates' : page;
  const who = me.displayName ?? me.email ?? 'You';

  return (
    <ToastProvider>
      <div className="shell">
        <aside className="sidebar" aria-label="Main">
          <div className="wordmark">PrepPilot</div>
          <div className="org-line">
            {noCompany ? 'No company picked' : me.orgName} · {ROLE_LABEL[me.role]}
            {me.isOwner && !noCompany && <> · <a href="#/companies">Switch</a></>}
          </div>
          <nav className="nav">
            {NAV.filter((n) => (!n.show || n.show(me)) && (!noCompany || n.page === 'companies')).map(({ page: p, label, icon: Icon }) => (
              <a key={p} href={routeHash({ page: p } as Route)} className={`nav-item ${active === p ? 'active' : ''}`} aria-current={active === p ? 'page' : undefined}>
                <Icon size={16} strokeWidth={1.75} />{label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="me">
              <Avatar name={who} />
              <div className="who"><div className="name" title={me.email ?? ''}>{who}</div><div className="role">{ROLE_LABEL[me.role]}</div></div>
            </div>
            <button className="signout" onClick={() => void supabase.auth.signOut()}><LogOut size={16} strokeWidth={1.75} /> Sign out</button>
          </div>
        </aside>
        <main className="main">
          <div className="page">
            {page === 'candidate' && route.page === 'candidate' && (
              <nav className="crumbs" aria-label="Breadcrumb">
                <a href="#/candidates">Candidates</a><ChevronRight size={13} /><span>{crumb ?? 'Candidate'}</span>
              </nav>
            )}
            {page === 'candidates' && <Candidates me={me} go={go} />}
            {page === 'candidate' && route.page === 'candidate' && <CandidateDetail me={me} id={route.id} go={go} onName={setCrumb} />}
            {page === 'interviews' && <Interviews me={me} go={go} />}
            {page === 'usage' && <Usage />}
            {page === 'team' && <TeamPage me={me} onSettingsChange={reloadMe} />}
            {page === 'audit' && isAdmin(me) && <Audit />}
            {page === 'companies' && me.isOwner && <Companies me={me} onSwitch={() => { reloadMe(); go({ page: 'candidates' }); }} />}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
};
