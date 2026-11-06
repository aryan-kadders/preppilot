// Display helpers for the dashboard: plain, locale-aware, no surprises.

export function minutesLabel(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function slotLabel(slot: { starts_at: string; ends_at: string } | null | undefined): string {
  if (!slot) return '—';
  const s = new Date(slot.starts_at);
  const e = new Date(slot.ends_at);
  const day = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(s)}–${t(e)}`;
}

export function money(usd: number | string | null | undefined): string {
  const n = Number(usd ?? 0);
  return n > 0 && n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`;
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

/** Slots on `count` days in a row from `firstStart` (weekends optional), each `durationMinutes` long. */
export function repeatedSlots(firstStart: Date, durationMinutes: number, count: number, skipWeekends: boolean): Array<{ starts_at: string; ends_at: string }> {
  const out: Array<{ starts_at: string; ends_at: string }> = [];
  const d = new Date(firstStart);
  for (let guard = 0; out.length < count && guard < count * 3 + 7; guard++) {
    const day = d.getDay();
    if (!(skipWeekends && (day === 0 || day === 6))) {
      out.push({ starts_at: d.toISOString(), ends_at: new Date(d.getTime() + durationMinutes * 60_000).toISOString() });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}
