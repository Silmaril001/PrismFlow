import { useEffect, useMemo, useState } from "react";
import {
  archiveFavorite,
  getFavoriteById,
  listFavorites,
  renameFavorite,
  type FavoriteDetail,
  type FavoriteSummary,
} from "../api";
import { ShaderPreview } from "../components/ShaderPreview";

const CARD_WIDTH = 320;
const CARD_HEIGHT = 180;

export function FavoritesGallery() {
  const [favorites, setFavorites] = useState<FavoriteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
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

  const countLabel = useMemo(() => `共 ${favorites.length} 个收藏`, [favorites.length]);

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

  async function handleRenameFavorite(id: string, currentName: string) {
    if (actionLoading) {
      return;
    }
    const nextName = window.prompt("输入新的收藏名称", currentName)?.trim();
    if (!nextName || nextName === currentName) {
      return;
    }

    setActionLoading(true);
    setError("");
    try {
      const updated = await renameFavorite(id, nextName);
      setFavorites((prev) =>
        prev.map((item) => (item.id === id ? { ...item, name: updated.name } : item)),
      );
      setDetailCache((prev) => {
        const current = prev[id];
        if (!current) {
          return prev;
        }
        return {
          ...prev,
          [id]: {
            ...current,
            name: updated.name,
            instructionFileName: updated.instructionFileName,
            codeFileName: updated.codeFileName,
          },
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleArchiveFavorite(id: string) {
    if (actionLoading) {
      return;
    }
    const confirmed = window.confirm("确认删除该收藏？删除后会移入下沉目录，不会显示在收藏页。");
    if (!confirmed) {
      return;
    }

    setActionLoading(true);
    setError("");
    try {
      await archiveFavorite(id);
      setFavorites((prev) => prev.filter((item) => item.id !== id));
      setDetailCache((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setHoveringId((prev) => (prev === id ? null : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <main className="favorites-shell">
      <header className="favorites-header">
        <div>
          <h1>Shader 收藏库</h1>
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
        <div className="favorites-empty">还没有收藏内容。回到主界面点星标即可加入这里。</div>
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
                  <details className="favorite-card-menu" onClick={(event) => event.stopPropagation()}>
                    <summary title="更多操作">⋯</summary>
                    <div className="favorite-card-menu-list">
                      <button
                        type="button"
                        onClick={() => handleRenameFavorite(item.id, item.name)}
                        disabled={actionLoading}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        onClick={() => handleArchiveFavorite(item.id)}
                        disabled={actionLoading}
                      >
                        删除
                      </button>
                    </div>
                  </details>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}
    </main>
  );
}
