import { useEffect, useState } from "react";
import {
  getGenerationLogByRevisionId,
  type GenerationLogDetail as GenerationLogDetailData,
} from "../api";
import { ShaderPreview } from "../components/ShaderPreview";

const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 540;

interface GenerationLogDetailProps {
  revisionId: string;
}

function compileStatusLabel(status: GenerationLogDetailData["compileStatus"]): string {
  if (status === "pass") {
    return "Compile Pass";
  }
  if (status === "fail") {
    return "Compile Fail";
  }
  return "Not Checked";
}

export function GenerationLogDetail(props: GenerationLogDetailProps) {
  const { revisionId } = props;
  const [item, setItem] = useState<GenerationLogDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setError("");
      setCopyNotice("");
      try {
        const detail = await getGenerationLogByRevisionId(revisionId);
        if (!cancelled) {
          setItem(detail);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load log details.");
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
  }, [revisionId]);

  async function handleCopyCode() {
    if (!item?.code.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(item.code);
      setCopyNotice("Code copied to clipboard.");
    } catch {
      setCopyNotice("Copy failed. Please copy manually.");
    }
  }

  return (
    <main className="favorite-detail-shell">
      <header className="favorite-detail-header">
        <div>
          <h1>Generation Log Details</h1>
          <p>Revision: {revisionId}</p>
        </div>
      </header>

      {loading ? <div className="favorites-empty">Loading...</div> : null}
      {error ? <pre className="compile-error">{error}</pre> : null}
      {copyNotice ? <div className="editor-notice">{copyNotice}</div> : null}

      {!loading && item ? (
        <section className="favorite-detail-layout">
          <div className="favorite-detail-preview-pane">
            <ShaderPreview
              fragmentShader={item.code}
              viewportWidth={PREVIEW_WIDTH}
              viewportHeight={PREVIEW_HEIGHT}
              paused={paused}
              showCompileError={false}
            />
            <button
              type="button"
              className="favorite-preview-floating-control"
              onClick={() => setPaused((prev) => !prev)}
              disabled={!item.code.trim()}
            >
              {paused ? "Play" : "Pause"}
            </button>
          </div>

          <div className="favorite-detail-editor-pane">
            <div className="favorite-detail-editor-title">Log Info</div>
            <div className="log-detail-meta">
              <div>Session: {item.sessionId}</div>
              <div>Mode: {item.mode}</div>
              <div>Status: {compileStatusLabel(item.compileStatus)}</div>
              <div>Model: {item.effectiveModel}</div>
              <div>Latency: {item.llmLatencyMs} ms</div>
              <div>Time: {new Date(item.createdAt).toLocaleString()}</div>
            </div>

            <div className="favorite-detail-editor-title">Original Prompt</div>
            <textarea
              className="favorite-prompt-input"
              value={item.prompt}
              readOnly
              rows={4}
            />

            {item.compileErrors.length > 0 ? (
              <>
                <div className="favorite-detail-editor-title">Compile Errors</div>
                <pre className="compile-error">{item.compileErrors.join("\n")}</pre>
              </>
            ) : null}

            <div className="favorite-detail-editor-title">GLSL Code (Read-only)</div>
            <textarea
              className="code-editor favorite-detail-editor"
              value={item.code}
              readOnly
              spellCheck={false}
            />
            <div className="favorite-detail-actions">
              <button type="button" onClick={handleCopyCode}>
                Copy Code
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
