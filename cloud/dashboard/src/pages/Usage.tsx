import React, { useCallback, useEffect, useState } from 'react';
import { Activity, BarChart3, Clock, DollarSign, Download, Sparkles } from 'lucide-react';
import { supabase } from '../supabase';
import { minutesLabel, money } from '../lib/format';
import { downloadCsv, toCsv } from '../lib/csv';
import { Alert, Avatar, EmptyState, Kpi, SkeletonRows, useAction } from '../components/ui';

interface ReportRow {
  candidate_id: string; candidate_name: string; team_name: string; sessions: number; used_seconds: number;
  ai_calls: number; input_tokens: number; output_tokens: number; cost_usd: number;
}

const RANGES = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
];

export const Usage: React.FC = () => {
  const [range, setRange] = useState('30');
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const load = useAction();
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    setRows(null);
    const days = RANGES.find((r) => r.id === range)?.days ?? 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);
    const { data, error } = await supabase.rpc('pp_usage_report', { p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) throw error;
    setRows((data as ReportRow[]).map((r) => ({ ...r, cost_usd: Number(r.cost_usd), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) })));
  }), [range, run]);

  useEffect(() => { void refresh(); }, [refresh]);

  const total = (rows ?? []).reduce((t, r) => ({
    sessions: t.sessions + r.sessions, used: t.used + r.used_seconds, calls: t.calls + r.ai_calls, cost: t.cost + r.cost_usd,
  }), { sessions: 0, used: 0, calls: 0, cost: 0 });
  const active = (rows ?? []).filter((r) => r.sessions > 0).sort((a, b) => b.used_seconds - a.used_seconds);
  const idle = (rows ?? []).filter((r) => r.sessions === 0);

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(
      ['Candidate', 'Team', 'Sessions', 'Minutes used', 'AI answers', 'Input tokens', 'Output tokens', 'AI cost (USD, estimate)'],
      rows.map((r) => [r.candidate_name, r.team_name, r.sessions, Math.round(r.used_seconds / 60), r.ai_calls, r.input_tokens, r.output_tokens, r.cost_usd.toFixed(4)]),
    );
    downloadCsv(`preppilot-usage-${range}d-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };
  const maxUsed = Math.max(1, ...active.map((r) => r.used_seconds));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Usage &amp; cost</h1>
          <p className="page-desc">Practice time and AI cost per candidate. Transcription is billed by Deepgram separately.</p>
        </div>
        <div className="row">
          <select className="input" style={{ width: 150 }} value={range} onChange={(e) => setRange(e.target.value)} aria-label="Period">
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button className="btn" onClick={exportCsv} disabled={!rows?.length}><Download size={14} /> Export CSV</button>
        </div>
      </div>

      <div className="kpis">
        <Kpi icon={<Activity size={14} />} label="Sessions" value={total.sessions} hint={`${active.length} candidates practised`} />
        <Kpi icon={<Clock size={14} />} label="Minutes practised" value={minutesLabel(total.used)} />
        <Kpi icon={<Sparkles size={14} />} label="AI answers" value={total.calls} />
        <Kpi icon={<DollarSign size={14} />} label="AI cost" value={money(total.cost)} hint="Estimate from server rates" />
      </div>

      <section className="card">
        {load.error && <div style={{ padding: 12 }}><Alert kind="error">{load.error}</Alert></div>}
        {rows === null ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
          <EmptyState icon={<BarChart3 size={20} />} title="No candidates yet" description="Usage appears here once candidates start practising." />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Candidate</th><th>Team</th><th className="num">Sessions</th><th style={{ width: '24%' }}>Minutes practised</th><th className="num">AI answers</th><th className="num">AI cost</th></tr></thead>
            <tbody>
              {[...active, ...idle].map((r) => (
                <tr key={r.candidate_id} className="clickable" onClick={() => { window.location.hash = `#/candidates/${r.candidate_id}`; }}>
                  <td><div className="cell-main"><Avatar name={r.candidate_name} /><span className="cell-title">{r.candidate_name}</span></div></td>
                  <td className="muted">{r.team_name}</td>
                  <td className="num">{r.sessions}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-subtle)', overflow: 'hidden' }}>
                        <div style={{ width: `${(r.used_seconds / maxUsed) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                      </div>
                      <span className="num" style={{ minWidth: 64 }}>{minutesLabel(r.used_seconds)}</span>
                    </div>
                  </td>
                  <td className="num">{r.ai_calls}</td>
                  <td className="num">{money(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
};
