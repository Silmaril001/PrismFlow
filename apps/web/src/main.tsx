import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FavoriteDetail } from "./pages/FavoriteDetail";
import { FavoritesGallery } from "./pages/FavoritesGallery";
import "./styles.css";

function resolvePage() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/favorites") {
    return <FavoritesGallery />;
  }
  if (pathname === "/favorites/new") {
    return <FavoriteDetail createMode />;
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
