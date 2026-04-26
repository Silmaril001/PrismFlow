import { useEffect, useMemo, useState } from "react";
import {
  createFavorite,
  createSession,
  getFavoriteById,
  sendMessage,
  type FavoriteDetail as FavoriteDetailData,
} from "../api";
import { ShaderPreview, captureShaderStillFrameDataUrl } from "../components/ShaderPreview";

const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 540;

const DEFAULT_NEW_FAVORITE_CODE = `precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float d = length(uv);
  float glow = 0.18 / max(0.002, d);
  vec3 col = vec3(0.02, 0.04, 0.08) + vec3(0.25, 0.65, 1.0) * glow;
  fragColor = vec4(col, 1.0);
}
`;

interface FavoriteDetailProps {
  favoriteId?: string;
  createMode?: boolean;
}

export function FavoriteDetail(props: FavoriteDetailProps) {
  const { favoriteId, createMode = false } = props;
  const [favorite, setFavorite] = useState<FavoriteDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [editorCode, setEditorCode] = useState("");
  const [compiledCode, setCompiledCode] = useState("");
  const [baselineCode, setBaselineCode] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [sourcePromptInput, setSourcePromptInput] = useState("");
  const [paused, setPaused] = useState(false);
  const [compileError, setCompileError] = useState("");
  const [debugSessionId, setDebugSessionId] = useState<string | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      setError("");
      setSaveNotice("");
      if (createMode) {
        if (!cancelled) {
          setFavorite(null);
          setEditorCode(DEFAULT_NEW_FAVORITE_CODE);
          setCompiledCode(DEFAULT_NEW_FAVORITE_CODE);
          setBaselineCode(DEFAULT_NEW_FAVORITE_CODE);
          setNameInput("New Shader");
          setSourcePromptInput("Manually created favorite");
          setLoading(false);
        }
        return;
      }

      if (!favoriteId) {
        if (!cancelled) {
          setError("Missing favorite ID.");
          setLoading(false);
        }
        return;
      }

      try {
        const detail = await getFavoriteById(favoriteId);
        if (!cancelled) {
          setFavorite(detail);
          setEditorCode(detail.code);
          setCompiledCode(detail.code);
          setBaselineCode(detail.code);
          setNameInput(`${detail.name} Copy`);
          setSourcePromptInput(detail.sourcePrompt || detail.promptPreview || "Manually saved favorite");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load favorite details.");
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
  }, [createMode, favoriteId]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapDebugSession() {
      try {
        const session = await createSession("shader_glsl");
        if (!cancelled) {
          setDebugSessionId(session.id);
        }
      } catch {
        if (!cancelled) {
          setDebugSessionId(null);
        }
      }
    }
    void bootstrapDebugSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => editorCode !== baselineCode, [editorCode, baselineCode]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function handleRunCompile() {
    setCompiledCode(editorCode);
  }

  async function handleDebugCode() {
    const sourceCode = editorCode.trim();
    if (!sourceCode || debugLoading) {
      return;
    }
    setDebugLoading(true);
    setError("");
    try {
      let sessionId = debugSessionId;
      if (!sessionId) {
        const created = await createSession("shader_glsl");
        sessionId = created.id;
        setDebugSessionId(created.id);
      }
      const result = await sendMessage(
        sessionId,
        "Debug current GLSL code and fix compile issues.",
        {
          startNewShader: false,
          currentCode: sourceCode,
          debugMode: true,
          referenceImages: [],
          previewCompileErrors: compileError.trim() ? [compileError.trim()] : [],
        },
      );
      setEditorCode(result.code);
      setCompiledCode(result.code);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code debug failed.");
    } finally {
      setDebugLoading(false);
    }
  }

  async function handleSaveAsFavorite() {
    const finalName = nameInput.trim();
    const sourcePrompt = sourcePromptInput.trim();
    const sourceCode = editorCode.trim();
    if (!finalName) {
      setError("Please enter a name before saving.");
      return;
    }
    if (!sourceCode) {
      setError("Please enter GLSL code before saving.");
      return;
    }
    if (saveLoading) {
      return;
    }

    setSaveLoading(true);
    setError("");
    setSaveNotice("");
    try {
      const coverImageDataUrl = captureShaderStillFrameDataUrl({
        fragmentShader: sourceCode,
        viewportWidth: PREVIEW_WIDTH,
        viewportHeight: PREVIEW_HEIGHT,
        seconds: 0,
      });
      const result = await createFavorite({
        name: finalName,
        sourcePrompt: sourcePrompt || "Manually saved favorite",
        promptPreview: sourcePrompt || finalName,
        code: sourceCode,
        coverImageDataUrl,
      });
      setSaveNotice(`New favorite saved: ${result.favorite.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save favorite.");
    } finally {
      setSaveLoading(false);
    }
  }

  const canRender = !loading && (createMode || Boolean(favorite));

  return (
    <main className="favorite-detail-shell">
      <header className="favorite-detail-header">
        <div>
          <h1>{createMode ? "Create Favorite" : favorite?.name || "Favorite Details"}</h1>
          {!createMode && favorite ? <p>{new Date(favorite.createdAt).toLocaleString()}</p> : null}
          {createMode ? <p>Enter GLSL manually, then name and save it as a new favorite.</p> : null}
        </div>
      </header>

      {loading ? <div className="favorites-empty">Loading...</div> : null}
      {error ? <pre className="compile-error">{error}</pre> : null}
      {saveNotice ? <div className="editor-notice">{saveNotice}</div> : null}

      {canRender ? (
        <section className="favorite-detail-layout">
          <div className="favorite-detail-preview-pane">
            <ShaderPreview
              fragmentShader={compiledCode || editorCode}
              viewportWidth={PREVIEW_WIDTH}
              viewportHeight={PREVIEW_HEIGHT}
              paused={paused}
              showCompileError={false}
              onCompileErrorChange={setCompileError}
            />
            <button
              type="button"
              className="favorite-preview-floating-control"
              onClick={() => setPaused((prev) => !prev)}
              disabled={loading || !(compiledCode || editorCode).trim()}
            >
              {paused ? "Play" : "Pause"}
            </button>
            {compileError ? <pre className="compile-error">{compileError}</pre> : null}
          </div>

          <div className="favorite-detail-editor-pane">
            <div className="favorite-detail-editor-title">Save Settings</div>
            <div className="favorite-save-row">
              <input
                type="text"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="Favorite name"
                className="favorite-name-input"
                disabled={saveLoading}
              />
              <button type="button" onClick={handleSaveAsFavorite} disabled={saveLoading || !editorCode.trim()}>
                {saveLoading ? "Saving..." : "Save"}
              </button>
            </div>
            <textarea
              className="favorite-prompt-input"
              value={sourcePromptInput}
              onChange={(event) => setSourcePromptInput(event.target.value)}
              rows={3}
              placeholder="Description for archiving (optional)"
              disabled={saveLoading}
            />

            <div className="favorite-detail-editor-title">GLSL Code (temporary edits, original favorite is unchanged)</div>
            <textarea
              className="code-editor favorite-detail-editor"
              value={editorCode}
              onChange={(event) => setEditorCode(event.target.value)}
              spellCheck={false}
            />
            <div className="favorite-detail-actions">
              <button
                type="button"
                onClick={handleRunCompile}
                disabled={!editorCode.trim() || debugLoading}
              >
                Compile & Run
              </button>
              <button
                type="button"
                onClick={handleDebugCode}
                disabled={!editorCode.trim() || debugLoading}
              >
                {debugLoading ? "Debugging..." : "Code Debug"}
              </button>
            </div>
            {dirty ? <div className="editor-notice">You have unsaved temporary edits. Closing this page will discard them.</div> : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
