import { useEffect, useMemo, useState } from "react";
import {
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  type AnalyticsBucket,
  type AnalyticsOverview,
  type AnalyticsTimeseriesPoint,
} from "../api";

type RangePreset = "24h" | "7d";

interface RangeConfig {
  label: string;
  hours: number;
  bucket: AnalyticsBucket;
}

const RANGE_CONFIG: Record<RangePreset, RangeConfig> = {
  "24h": {
    label: "Last 24 Hours",
    hours: 24,
    bucket: "hour",
  },
  "7d": {
    label: "Last 7 Days",
    hours: 24 * 7,
    bucket: "day",
  },
};

function calcRate(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((value / total) * 100)}%`;
}

function formatBucket(value: string, bucket: AnalyticsBucket): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  if (bucket === "day") {
    return date.toLocaleDateString();
  }
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AnalyticsDashboard() {
  const [rangePreset, setRangePreset] = useState<RangePreset>("24h");
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [series, setSeries] = useState<AnalyticsTimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      setError("");
      const config = RANGE_CONFIG[rangePreset];
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - config.hours * 60 * 60 * 1000);

      try {
        const [overviewData, timeseriesData] = await Promise.all([
          getAnalyticsOverview({
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
          }),
          getAnalyticsTimeseries({
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            bucket: config.bucket,
          }),
        ]);

        if (!cancelled) {
          setOverview(overviewData);
          setSeries(timeseriesData.items);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load analytics data.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [rangePreset]);

  const maxSeriesTotal = useMemo(() => {
    const max = series.reduce((currentMax, point) => Math.max(currentMax, point.totalRequests), 0);
    return Math.max(max, 1);
  }, [series]);

  const config = RANGE_CONFIG[rangePreset];

  return (
    <main className="favorites-shell">
      <header className="favorites-header">
        <div>
          <h1>Traffic Analytics</h1>
          <p>{config.label}</p>
        </div>
        <div className="favorites-header-actions">
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => setRangePreset("24h")}
            disabled={loading || rangePreset === "24h"}
          >
            Last 24H
          </button>
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => setRangePreset("7d")}
            disabled={loading || rangePreset === "7d"}
          >
            Last 7D
          </button>
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => window.location.reload()}
            disabled={loading}
          >
            Refresh
          </button>
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => {
              window.location.href = "/logs";
            }}
          >
            Back to Logs
          </button>
        </div>
      </header>

      {loading ? <div className="favorites-empty">Loading...</div> : null}
      {error ? <pre className="compile-error">{error}</pre> : null}

      {!loading && overview ? (
        <>
          <section className="analytics-cards" aria-label="analytics-overview-cards">
            <article className="analytics-card">
              <h3>Total Requests</h3>
              <div className="analytics-value">{overview.totalRequests}</div>
            </article>
            <article className="analytics-card">
              <h3>Generation Requests</h3>
              <div className="analytics-value">{overview.generationRequests}</div>
              <div className="analytics-sub">
                Success Rate {calcRate(overview.generationSuccesses, overview.generationRequests)}
              </div>
            </article>
            <article className="analytics-card">
              <h3>Unique Visitors</h3>
              <div className="analytics-value">{overview.uniqueClients}</div>
            </article>
            <article className="analytics-card">
              <h3>Avg Duration</h3>
              <div className="analytics-value">{overview.avgDurationMs} ms</div>
            </article>
            <article className="analytics-card">
              <h3>Response Summary</h3>
              <div className="analytics-sub">2xx: {overview.successResponses}</div>
              <div className="analytics-sub">4xx: {overview.clientErrors}</div>
              <div className="analytics-sub">5xx: {overview.serverErrors}</div>
            </article>
          </section>

          <section className="analytics-series" aria-label="analytics-timeseries">
            <div className="analytics-series-title">
              Time Trend ({config.bucket === "hour" ? "Hourly" : "Daily"})
            </div>
            {series.length === 0 ? (
              <div className="favorites-empty">No request data in the current time range.</div>
            ) : (
              <div className="analytics-series-list">
                {series.map((point) => (
                  <div key={point.bucketStart} className="analytics-series-row">
                    <div className="analytics-series-time">{formatBucket(point.bucketStart, config.bucket)}</div>
                    <div className="analytics-series-bar-wrap">
                      <div
                        className="analytics-series-bar"
                        style={{ width: `${Math.round((point.totalRequests / maxSeriesTotal) * 100)}%` }}
                      />
                    </div>
                    <div className="analytics-series-values">
                      <span>Requests {point.totalRequests}</span>
                      <span>Generations {point.generationRequests}</span>
                      <span>Success {point.generationSuccesses}</span>
                      <span>Visitors {point.uniqueClients}</span>
                      <span>Avg {point.avgDurationMs}ms</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
