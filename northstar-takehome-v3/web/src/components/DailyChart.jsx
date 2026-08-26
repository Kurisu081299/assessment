// Hand-rolled SVG chart -- no charting dependency. Net revenue as bars, ad spend
// as an overlaid line, both scaled to the same axis so the relationship between
// them (including a spend-only day: a line point with no bar under it) is visible.
export default function DailyChart({ daily }) {
  const width = 760;
  const height = 220;
  const padding = 36;
  const innerHeight = height - padding * 2;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.netRevenue, d.adSpend)));
  const barWidth = (width - padding * 2) / daily.length;
  const scaleY = (v) => height - padding - (Math.max(v, 0) / max) * innerHeight;

  const linePoints = daily
    .map((d, i) => `${padding + i * barWidth + barWidth / 2},${scaleY(d.adSpend)}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="daily-chart" role="img" aria-label="Daily net revenue and ad spend">
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="chart-axis" />
      {daily.map((d, i) => {
        const barHeight = (Math.max(d.netRevenue, 0) / max) * innerHeight;
        return (
          <rect
            key={d.date}
            x={padding + i * barWidth + barWidth * 0.15}
            y={height - padding - barHeight}
            width={barWidth * 0.7}
            height={barHeight}
            className="chart-bar"
          >
            <title>{`${d.date}: net ${d.netRevenue.toFixed(2)}, spend ${d.adSpend.toFixed(2)}`}</title>
          </rect>
        );
      })}
      <polyline points={linePoints} className="chart-line" />
      {daily.map((d, i) => (
        <circle
          key={`${d.date}-dot`}
          cx={padding + i * barWidth + barWidth / 2}
          cy={scaleY(d.adSpend)}
          r={2.5}
          className="chart-dot"
        />
      ))}
      <text x={padding} y={16} className="chart-legend">
        ▮ net revenue &nbsp;&nbsp; ─ ad spend
      </text>
    </svg>
  );
}
