import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AnalyticsDashboard } from "./pages/AnalyticsDashboard";
import { FavoriteDetail } from "./pages/FavoriteDetail";
import { FavoritesGallery } from "./pages/FavoritesGallery";
import { GenerationLogDetail } from "./pages/GenerationLogDetail";
import { GenerationLogsGallery } from "./pages/GenerationLogsGallery";
import "./styles.css";

function resolvePage() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/favorites") {
    return <FavoritesGallery />;
  }
  if (pathname === "/logs") {
    return <GenerationLogsGallery />;
  }
  if (pathname === "/logs/analytics") {
    return <AnalyticsDashboard />;
  }
  if (pathname === "/favorites/new") {
    return <FavoriteDetail createMode />;
  }
  const logDetailMatch = pathname.match(/^\/logs\/([^/]+)$/);
  if (logDetailMatch?.[1]) {
    return <GenerationLogDetail revisionId={decodeURIComponent(logDetailMatch[1])} />;
  }
  const detailMatch = pathname.match(/^\/favorites\/([^/]+)$/);
  if (detailMatch?.[1]) {
    return <FavoriteDetail favoriteId={decodeURIComponent(detailMatch[1])} />;
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {resolvePage()}
  </StrictMode>,
);
