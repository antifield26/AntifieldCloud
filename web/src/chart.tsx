// 轻量 SVG 折线：无数据段（间隔 > gapMs）不断假线。
interface Pt {
  ts: number;
  v: number | null;
}

export function LineChart(props: { data: Pt[]; color: string; unit: string; gapMs?: number }) {
  const W = 560;
  const H = 120;
  const gap = props.gapMs ?? 15 * 60 * 1000;
  const vs = props.data.map((d) => d.v).filter((x): x is number => x !== null);
  if (props.data.length < 2 || vs.length === 0) {
    return <div class="text-gray-400 text-sm">数据不足</div>;
  }
  const t0 = props.data[0].ts;
  const t1 = props.data[props.data.length - 1].ts;
  const span = Math.max(t1 - t0, 1);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo || 1) * 0.1;
  const X = (t: number): number => 30 + ((t - t0) / span) * (W - 40);
  const Y = (v: number): number => H - 15 - ((v - lo + pad) / (hi - lo + pad * 2)) * (H - 30);
  const segs: string[] = [];
  let cur: string[] = [];
  let prev = -Infinity;
  for (const d of props.data) {
    if (d.v === null || d.ts - prev > gap) {
      if (cur.length > 1) segs.push(`M${cur.join('L')}`);
      cur = [];
    }
    if (d.v !== null) cur.push(`${X(d.ts).toFixed(1)},${Y(d.v).toFixed(1)}`);
    prev = d.ts;
  }
  if (cur.length > 1) segs.push(`M${cur.join('L')}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="w-full">
      {segs.map((d) => (
        <path d={d} fill="none" stroke={props.color} stroke-width="1.5" />
      ))}
      <text x="2" y="12" font-size="10" fill="#888">
        {hi.toFixed(1)}{props.unit}
      </text>
      <text x="2" y={H - 4} font-size="10" fill="#888">
        {lo.toFixed(1)}{props.unit}
      </text>
    </svg>
  );
}
