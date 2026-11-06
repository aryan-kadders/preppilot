export type Role = 'admin' | 'manager' | 'coach';

export interface Me {
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string;
  role: Role;
  displayName: string | null;
}

export interface Slot { starts_at: string; ends_at: string }

export interface CandidateRow {
  id: string;
  org_id: string;
  team_id: string;
  team_name: string;
  name: string;
  email: string | null;
  status: 'invited' | 'active' | 'archived';
  created_at: string;
  balance_seconds: number;
  current_slot: Slot | null;
  next_slot: Slot | null;
  last_session_at: string | null;
  in_session: boolean;
  used_seconds_7d: number;
  active_devices: number;
}

export interface Team { id: string; name: string; org_id: string }

/** The page in the address bar: #/candidates, #/candidates/<id>, #/usage, #/team, #/audit. */
export type Route =
  | { page: 'candidates' }
  | { page: 'candidate'; id: string }
  | { page: 'usage' }
  | { page: 'team' }
  | { page: 'audit' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'candidates' && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) return { page: 'candidate', id: parts[1] };
  if (parts[0] === 'usage') return { page: 'usage' };
  if (parts[0] === 'team') return { page: 'team' };
  if (parts[0] === 'audit') return { page: 'audit' };
  return { page: 'candidates' };
}

export function routeHash(r: Route): string {
  return r.page === 'candidate' ? `#/candidates/${r.id}` : `#/${r.page}`;
}
