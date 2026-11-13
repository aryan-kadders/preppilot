/** A staff role inside one organization. */
export type Role = 'admin' | 'manager' | 'recruiter' | 'coach';

export interface Me {
  userId: string;
  email: string | null;
  /** The organization being worked in; for an owner, the one they picked. */
  orgId: string;
  orgName: string;
  /** 'owner': the people who build PrepPilot, admin of whichever organization they pick. */
  role: Role | 'owner';
  isOwner: boolean;
  displayName: string | null;
  /** The organization only lets candidates practise inside booked slots. */
  requireSlots: boolean;
}

/** Everything in the organization: teams, staff, settings, the audit log. */
export const isAdmin = (me: Me) => me.role === 'owner' || me.role === 'admin';
/** Candidates' minutes, slots, invite codes, assignments, computers. */
export const canManage = (me: Me) => isAdmin(me) || me.role === 'manager';
/** Adding client interviews and recording how they went. */
export const canRecruit = (me: Me) => canManage(me) || me.role === 'recruiter';
/** Saying whether a candidate is ready for an interview. */
export const canJudgeReadiness = (me: Me) => canManage(me) || me.role === 'coach';

export const ROLE_LABEL: Record<Me['role'], string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', recruiter: 'Recruiter', coach: 'Coach',
};

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

export type Readiness = 'ready' | 'needs_work';
export type Outcome = 'selected' | 'rejected' | 'on_hold' | 'cancelled' | 'no_show';

export interface InterviewRow {
  id: string;
  candidate_id: string;
  assignment_id: string | null;
  company: string;
  role_title: string;
  round: string | null;
  job_description: string | null;
  interview_at: string;
  readiness: Readiness | null;
  readiness_note: string | null;
  readiness_at: string | null;
  outcome: Outcome | null;
  outcome_note: string | null;
  outcome_at: string | null;
  created_at: string;
  candidate_name: string;
  team_id: string;
  team_name: string;
  candidate_status: 'invited' | 'active' | 'archived';
  balance_seconds: number;
  practice_sessions: number;
  practice_seconds: number;
  last_practice_at: string | null;
}

/** The page in the address bar: #/candidates, #/candidates/<id>, #/interviews, #/usage, #/team, #/audit, #/companies. */
export type Route =
  | { page: 'candidates' }
  | { page: 'candidate'; id: string }
  | { page: 'interviews' }
  | { page: 'usage' }
  | { page: 'team' }
  | { page: 'audit' }
  | { page: 'companies' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'candidates' && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) return { page: 'candidate', id: parts[1] };
  if (parts[0] === 'interviews') return { page: 'interviews' };
  if (parts[0] === 'companies') return { page: 'companies' };
  if (parts[0] === 'usage') return { page: 'usage' };
  if (parts[0] === 'team') return { page: 'team' };
  if (parts[0] === 'audit') return { page: 'audit' };
  return { page: 'candidates' };
}

export function routeHash(r: Route): string {
  return r.page === 'candidate' ? `#/candidates/${r.id}` : `#/${r.page}`;
}
