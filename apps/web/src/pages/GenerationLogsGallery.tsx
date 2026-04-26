import { useEffect, useMemo, useState } from "react";
import {
  getGenerationLogByRevisionId,
  listGenerationLogs,
  type GenerationLogDetail,
  type GenerationLogSummary,
} from "../api";
import { ShaderPreview } from "../components/ShaderPreview";

const CARD_WIDTH = 320;
const CARD_HEIGHT = 180;
const PAGE_SIZE = 24;

function compileStatusLabel(status: GenerationLogSummary["compileStatus"]): string {
  if (status === "pass") {
    return "Compile Pass";
  }
  if (status === "fail") {
    return "Compile Fail";
  }
  return "Not Checked";
}

export function GenerationLogsGallery() {
  const [items, setItems] = useState<GenerationLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hoveringId, setHoveringId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, GenerationLogDetail>>({});
  const [detailLoadingIds, setDetailLoadingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        const response = await listGenerationLogs({
          limit: PAGE_SIZE,
          offset,
        });
        if (!cancelled) {
          setItems(response.items);
          setTotal(response.total);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load generation logs.");
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
  }, [offset]);

  const pageLabel = useMemo(() => {
    const start = Math.min(total, offset + 1);
    const end = Math.min(total, offset + items.length);
    if (items.length === 0) {
      return `Total ${total}`;
    }
    return `${start}-${end} / Total ${total}`;
  }, [items.length, offset, total]);

  async function ensureDetailLoaded(revisionId: string) {
    if (detailCache[revisionId] || detailLoadingIds[revisionId]) {
      return;
    }
    setDetailLoadingIds((prev) => ({ ...prev, [revisionId]: true }));
    try {
      const detail = await getGenerationLogByRevisionId(revisionId);
      setDetailCache((prev) => ({ ...prev, [revisionId]: detail }));
    } catch {
      // Keep placeholder card if detail loading failed.
    } finally {
      setDetailLoadingIds((prev) => ({ ...prev, [revisionId]: false }));
    }
  }

  function handleOpenDetail(revisionId: string) {
    window.open(`/logs/${encodeURIComponent(revisionId)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="favorites-shell">
      <header className="favorites-header">
        <div>
          <div className="logs-title-row">
            <h1>Generation Logs</h1>
            <button
              type="button"
              className="favorites-refresh-button"
              onClick={() => {
                window.location.href = "/logs/analytics";
              }}
            >
              Analytics
            </button>
          </div>
          <p>{pageLabel}</p>
        </div>
        <div className="favorites-header-actions">
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
            disabled={loading || offset <= 0}
          >
            Prev
          </button>
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
            disabled={loading || offset + items.length >= total}
          >
            Next
          </button>
          <button
            type="button"
            className="favorites-refresh-button"
            onClick={() => window.location.reload()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {loading ? <div className="favorites-empty">Loading...</div> : null}
      {!loading && items.length === 0 ? (
        <div className="favorites-empty">
          No log data yet. Generate some shaders on the main page, then come back to view them.
        </div>
      ) : null}
      {error ? <pre className="compile-error">{error}</pre> : null}

      {!loading && items.length > 0 ? (
        <section className="favorites-grid" aria-label="generation-logs-grid">
          {items.map((item) => {
            const detail = detailCache[item.revisionId];
            const hovered = hoveringId === item.revisionId;
            return (
              <article
                key={item.revisionId}
                className="favorite-card"
                onMouseEnter={() => {
                  setHoveringId(item.revisionId);
                  void ensureDetailLoaded(item.revisionId);
                }}
                onMouseLeave={() =>
                  setHoveringId((prev) => (prev === item.revisionId ? null : prev))
                }
              >
                <button
                  type="button"
                  className="favorite-card-preview"
                  onClick={() => handleOpenDetail(item.revisionId)}
                  title="Open log details in a new tab"
                >
                  {!hovered || !detail ? (
                    <div className="log-card-placeholder">
                      <div className="log-card-placeholder-title">Revision {item.revisionId}</div>
                      <div className="log-card-placeholder-sub">{compileStatusLabel(item.compileStatus)}</div>
                    </div>
                  ) : (
                    <div className="favorite-card-live">
                      <ShaderPreview
                        fragmentShader={detail.code}
                        viewportWidth={CARD_WIDTH}
                        viewportHeight={CARD_HEIGHT}
                        showCompileError={false}
                      />
                    </div>
                  )}
                </button>
                <div className="favorite-card-meta">
                  <div className="favorite-card-main">
                    <div className="favorite-card-name" title={item.promptPreview}>
                      {item.promptPreview || "(Empty prompt)"}
                    </div>
                    <div className="favorite-card-time">
                      {new Date(item.createdAt).toLocaleString()}
                    </div>
                    <div className="log-card-stats">
                      <span>{compileStatusLabel(item.compileStatus)}</span>
                      <span>{item.effectiveModel}</span>
                      <span>{item.llmLatencyMs} ms</span>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}
    </main>
  );
}
