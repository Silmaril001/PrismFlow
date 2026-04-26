import { useEffect, useMemo, useState } from "react";
import {
  getFavoriteById,
  listFavorites,
  type FavoriteDetail,
  type FavoriteSummary,
} from "../api";
import { ShaderPreview } from "../components/ShaderPreview";

const CARD_WIDTH = 320;
const CARD_HEIGHT = 180;

export function FavoritesGallery() {
  const [favorites, setFavorites] = useState<FavoriteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hoveringId, setHoveringId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, FavoriteDetail>>({});
  const [detailLoadingIds, setDetailLoadingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        const items = await listFavorites();
        if (!cancelled) {
          setFavorites(items);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load favorites list.");
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
  }, []);

  const countLabel = useMemo(
    () => `Public Favorites Gallery · ${favorites.length} item${favorites.length === 1 ? "" : "s"}`,
    [favorites.length],
  );

  async function ensureDetailLoaded(id: string) {
    if (detailCache[id] || detailLoadingIds[id]) {
      return;
    }
    setDetailLoadingIds((prev) => ({ ...prev, [id]: true }));
    try {
      const detail = await getFavoriteById(id);
      setDetailCache((prev) => ({ ...prev, [id]: detail }));
    } catch {
      // Keep static thumbnail if detail loading fails.
    } finally {
      setDetailLoadingIds((prev) => ({ ...prev, [id]: false }));
    }
  }

  function handleOpenDetail(id: string) {
    window.open(`/favorites/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
  }

  function handleOpenCreate() {
    window.open("/favorites/new", "_blank", "noopener,noreferrer");
  }

  return (
    <main className="favorites-shell">
      <header className="favorites-header">
        <div>
          <h1>Public Favorites Gallery</h1>
          <p>{countLabel}</p>
        </div>
        <div className="favorites-header-actions">
          <button
            type="button"
            onClick={handleOpenCreate}
            className="favorites-refresh-button"
            disabled={loading}
          >
            New
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="favorites-refresh-button"
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {loading ? <div className="favorites-empty">Loading...</div> : null}
      {!loading && favorites.length === 0 ? (
        <div className="favorites-empty">
          No public favorites yet. Go back to the main page and click the star to publish here.
        </div>
      ) : null}
      {error ? <pre className="compile-error">{error}</pre> : null}

      {!loading && favorites.length > 0 ? (
        <section className="favorites-grid" aria-label="favorites-grid">
          {favorites.map((item) => {
            const detail = detailCache[item.id];
            const hovered = hoveringId === item.id;
            return (
              <article
                key={item.id}
                className="favorite-card"
                onMouseEnter={() => {
                  setHoveringId(item.id);
                  void ensureDetailLoaded(item.id);
                }}
                onMouseLeave={() => setHoveringId((prev) => (prev === item.id ? null : prev))}
              >
                <button
                  type="button"
                  className="favorite-card-preview"
                  onClick={() => handleOpenDetail(item.id)}
                  title="Open details in a new tab"
                >
                  <img src={item.coverImageDataUrl} alt={item.name} loading="lazy" />
                  {hovered && detail ? (
                    <div className="favorite-card-live">
                      <ShaderPreview
                        fragmentShader={detail.code}
                        viewportWidth={CARD_WIDTH}
                        viewportHeight={CARD_HEIGHT}
                        showCompileError={false}
                      />
                    </div>
                  ) : null}
                </button>
                <div className="favorite-card-meta">
                  <div className="favorite-card-main">
                    <div className="favorite-card-name" title={item.name}>
                      {item.name}
                    </div>
                    <div className="favorite-card-time">
                      {new Date(item.createdAt).toLocaleString()}
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
