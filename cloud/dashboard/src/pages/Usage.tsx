import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { minutesLabel, money } from '../lib/format';
import { downloadCsv, toCsv } from '../lib/csv';
import { Empty, Notice, useAction } from '../components/ui';

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

  const refresh = useCallback(() => load.run(async () => {
    const days = RANGES.find((r) => r.id === range)?.days ?? 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);
    const { data, error } = await supabase.rpc('pp_usage_report', { p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) throw error;
    setRows((data as ReportRow[]).map((r) => ({ ...r, cost_usd: Number(r.cost_usd), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [range]);

  useEffect(() => { void refresh(); }, [refresh]);

  const total = (rows ?? []).reduce((t, r) => ({
    sessions: t.sessions + r.sessions, used: t.used + r.used_seconds, calls: t.calls + r.ai_calls, cost: t.cost + r.cost_usd,
  }), { sessions: 0, used: 0, calls: 0, cost: 0 });

  const exportCsv = () => {
    if (!rows) return;
    const csv = toCsv(
      ['Candidate', 'Team', 'Sessions', 'Minutes used', 'AI answers', 'Input tokens', 'Output tokens', 'AI cost (USD, estimate)'],
      rows.map((r) => [r.candidate_name, r.team_name, r.sessions, Math.round(r.used_seconds / 60), r.ai_calls, r.input_tokens, r.output_tokens, r.cost_usd.toFixed(4)]),
    );
    downloadCsv(`preppilot-usage-${range}d-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usage &amp; cost</h1>
          <p className="subtitle">Minutes used and AI cost per candidate. Transcription cost is on your Deepgram bill.</p>
        </div>
        <div className="row">
          <select className="input" style={{ width: 160 }} value={range} onChange={(e) => setRange(e.target.value)} aria-label="Period">
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button className="btn" onClick={exportCsv} disabled={!rows?.length}>Export CSV</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="label">Sessions</div><div className="value">{total.sessions}</div></div>
        <div className="stat"><div className="label">Minutes used</div><div className="value">{minutesLabel(total.used)}</div></div>
        <div className="stat"><div className="label">AI answers</div><div className="value">{total.calls}</div></div>
        <div className="stat"><div className="label">AI cost (estimate)</div><div className="value">{money(total.cost)}</div></div>
      </div>
      <div className="card">
        {load.error && <Notice kind="error">{load.error}</Notice>}
        {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No candidates yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Candidate</th><th>Team</th><th className="num">Sessions</th><th className="num">Minutes used</th><th className="num">AI answers</th><th className="num">AI cost</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.candidate_id} className="clickable" onClick={() => { window.location.hash = `#/candidates/${r.candidate_id}`; }}>
                  <td><strong>{r.candidate_name}</strong></td><td className="muted">{r.team_name}</td>
                  <td className="num">{r.sessions}</td><td className="num">{minutesLabel(r.used_seconds)}</td>
                  <td className="num">{r.ai_calls}</td><td className="num">{money(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <p className="faint" style={{ marginBottom: 0 }}>AI cost uses the rates set on the server (GEMINI_PRICES); check your Google bill for exact amounts.</p>
      </div>
    </>
  );
};
