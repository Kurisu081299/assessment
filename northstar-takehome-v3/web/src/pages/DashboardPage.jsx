import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchDashboard, triggerReingest } from "../api.js";
import KpiCards from "../components/KpiCards.jsx";
import DailyTable from "../components/DailyTable.jsx";
import DailyChart from "../components/DailyChart.jsx";
import IssuesStrip from "../components/IssuesStrip.jsx";
import ComparisonStrip from "../components/ComparisonStrip.jsx";
import NotFoundPage from "./NotFoundPage.jsx";
import { localDateTime } from "../format.js";

export default function DashboardPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  // Stretch: trigger a re-ingest without restarting the server, then refetch
  // this dashboard so the new numbers show up without a page reload.
  const [reingesting, setReingesting] = useState(false);
  const [reingestNote, setReingestNote] = useState(null);

  const load = useCallback(() => {
    let cancelled = false;
    setNotFound(false);
    setError(null);

    fetchDashboard(token)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) setNotFound(true);
        else setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    setData(null);
    return load();
  }, [load]);

  const handleReingest = async () => {
    setReingesting(true);
    setReingestNote(null);
    try {
      const result = await triggerReingest();
      setReingestNote(`Re-ingest ${result.status} in ${result.wallMs.toFixed(0)}ms.`);
      load();
    } catch (err) {
      setReingestNote(
        err.status === 409 ? "Another ingest is already in progress." : `Re-ingest failed: ${err.message}`
      );
    } finally {
      setReingesting(false);
    }
  };

  if (notFound) return <NotFoundPage />;
  if (error) return <div className="page-center">Something went wrong: {error}</div>;
  if (!data) return <div className="page-center">Loading…</div>;

  const { company, range, daily, totals, lastIngestAt, issues, excludedForeignSpend, excludedForeignRevenue, comparison } =
    data;
  const localIngestAt = lastIngestAt ? localDateTime(lastIngestAt, company.timezone) : null;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>{company.name}</h1>
        <div className="dashboard-meta">
          <span>{company.currency}</span>
          <span>{company.timezone}</span>
          <span>
            {range.start} – {range.end}
          </span>
        </div>
      </header>

      <KpiCards totals={totals} currency={company.currency} />

      <ComparisonStrip comparison={comparison} currency={company.currency} />

      <section className="chart-section">
        <h2>Daily</h2>
        <DailyChart daily={daily} currency={company.currency} />
      </section>

      <section>
        <DailyTable daily={daily} currency={company.currency} />
      </section>

      <IssuesStrip
        issues={issues}
        excludedForeignSpend={excludedForeignSpend}
        excludedForeignRevenue={excludedForeignRevenue}
        currency={company.currency}
      />

      <footer className="dashboard-footer">
        <span title={lastIngestAt ? `${lastIngestAt} UTC` : undefined}>
          Last successful ingest: {localIngestAt ?? "never"}
        </span>
        <button className="reingest-button" onClick={handleReingest} disabled={reingesting}>
          {reingesting ? "Re-ingesting…" : "Re-ingest now"}
        </button>
        {reingestNote && <span className="reingest-note">{reingestNote}</span>}
      </footer>
    </div>
  );
}
