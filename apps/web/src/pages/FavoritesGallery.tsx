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
          setError(err instanceof Error ? err.message : "收藏列表加载失败");
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

  const countLabel = useMemo(() => `公共收藏广场 · 共 ${favorites.length} 个作品`, [favorites.length]);

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
          <h1>公共收藏广场</h1>
          <p>{countLabel}</p>
        </div>
        <div className="favorites-header-actions">
          <button
            type="button"
            onClick={handleOpenCreate}
            className="favorites-refresh-button"
            disabled={loading}
          >
            新建
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="favorites-refresh-button"
            disabled={loading}
          >
            刷新
          </button>
        </div>
      </header>

      {loading ? <div className="favorites-empty">加载中...</div> : null}
      {!loading && favorites.length === 0 ? (
        <div className="favorites-empty">公共收藏广场还没有内容。回到主界面点星标即可发布到这里。</div>
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
                  title="新标签页打开详情"
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
