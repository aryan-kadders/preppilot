// "Your progress" for mock interviews (PrepPilot): stat tiles, a score-over-
// time line with a hover readout, averages by question type, and recurring
// focus areas. Data from practice:progress (electron/practice/progress.ts).
//
// Chart rules followed (dataviz skill): one series, so no legend — the heading
// names it; a 2px line in one accent; text in text tokens, never the series
// colour; a crosshair + tooltip on hover; the trend carries an arrow and a word,
// not colour alone; the same numbers as a table for screen readers.

import React, { useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import type { PracticeProgress } from '../../types/practice';

const KIND: Record<string, string> = { mixed: 'Mixed', behavioral: 'Behavioural', technical: 'Technical' };
const W = 236;
const H = 64;
const PAD = 6;

const Tile: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex-1 rounded-lg border border-border-subtle px-2 py-1.5">
    <div className="text-[10px] text-text-tertiary">{label}</div>
    <div className="text-sm font-bold text-text-primary">{value}</div>
  </div>
);

export const ProgressView: React.FC<{ progress: PracticeProgress }> = ({ progress }) => {
  const [hover, setHover] = useState<number | null>(null);
  const pts = progress.recent;
  const x = (i: number) => (pts.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (pts.length - 1));
  const y = (score: number) => PAD + ((10 - score) / 10) * (H - 2 * PAD);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.averageScore).toFixed(1)}`).join(' ');

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!pts.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };

  const t = progress.trend;
  const trend = t === null ? <span className="text-text-tertiary">–</span>
    : t > 0.2 ? <span className="inline-flex items-center gap-0.5"><ArrowUpRight size={13} aria-hidden />Up {t}</span>
      : t < -0.2 ? <span className="inline-flex items-center gap-0.5"><ArrowDownRight size={13} aria-hidden />Down {Math.abs(t)}</span>
        : <span className="inline-flex items-center gap-0.5"><ArrowRight size={13} aria-hidden />Steady</span>;
  const hovered = hover !== null ? pts[hover] : null;

  return (
    <section className="space-y-2.5" aria-labelledby="pi-progress-title">
      <h3 id="pi-progress-title" className="text-xs font-semibold text-text-secondary">Your progress</h3>
      <div className="flex gap-1.5">
        <Tile label="Sessions" value={progress.sessions} />
        <Tile label="Avg score" value={progress.averageScore ?? '–'} />
        <Tile label="Trend" value={trend} />
      </div>

      {pts.length >= 2 && (
        <div>
          <div className="mb-0.5 flex items-baseline justify-between text-[10px] text-text-tertiary">
            <span>Average score per session (0–10)</span>
            <span aria-live="polite">{hovered ? `${new Date(hovered.createdAt).toLocaleDateString()} · ${hovered.averageScore}/10` : `last ${pts.length}`}</span>
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full text-sky-500"
            role="img"
            aria-label={`Average score per session, last ${pts.length} sessions, from ${pts[0].averageScore} to ${pts[pts.length - 1].averageScore} out of 10`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* recessive reference at the midpoint */}
            <line x1={PAD} x2={W - PAD} y1={y(5)} y2={y(5)} className="stroke-border-subtle" strokeWidth={1} strokeDasharray="2 3" />
            <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hovered && hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD} y2={H - PAD} className="stroke-text-tertiary" strokeWidth={1} />
                <circle cx={x(hover)} cy={y(hovered.averageScore)} r={4} fill="currentColor" className="stroke-bg-elevated" strokeWidth={2} />
              </>
            )}
            {/* a bigger hit area than the line */}
            <rect x={0} y={0} width={W} height={H} fill="transparent" />
          </svg>
          <table className="sr-only">
            <caption>Average score per session</caption>
            <thead><tr><th>Date</th><th>Role</th><th>Score</th></tr></thead>
            <tbody>{pts.map((p) => <tr key={p.id}><td>{new Date(p.createdAt).toLocaleDateString()}</td><td>{p.role}</td><td>{p.averageScore}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      {progress.byKind.length > 1 && (
        <ul className="space-y-0.5 text-[11px] text-text-secondary">
          {progress.byKind.map((k) => (
            <li key={k.kind} className="flex justify-between"><span>{KIND[k.kind] ?? k.kind}</span><span className="text-text-primary">{k.averageScore}/10 · {k.sessions}</span></li>
          ))}
        </ul>
      )}
      {progress.averageWpm !== null && <p className="text-[11px] text-text-secondary">Speaking pace: about {progress.averageWpm} words a minute.</p>}
      {progress.focusAreas.length > 0 && (
        <div>
          <div className="text-[10px] text-text-tertiary">Keeps coming up</div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">{progress.focusAreas.map((f) => <li key={f}>{f}</li>)}</ul>
        </div>
      )}
    </section>
  );
};
