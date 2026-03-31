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
          setNameInput("新建Shader");
          setSourcePromptInput("手动新建收藏");
          setLoading(false);
        }
        return;
      }

      if (!favoriteId) {
        if (!cancelled) {
          setError("缺少收藏 ID。");
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
          setNameInput(`${detail.name}-副本`);
          setSourcePromptInput(detail.sourcePrompt || detail.promptPreview || "手动保存收藏");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "收藏详情加载失败");
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
      setError(err instanceof Error ? err.message : "代码debug失败");
    } finally {
      setDebugLoading(false);
    }
  }

  async function handleSaveAsFavorite() {
    const finalName = nameInput.trim();
    const sourcePrompt = sourcePromptInput.trim();
    const sourceCode = editorCode.trim();
    if (!finalName) {
      setError("保存前请先填写名称。");
      return;
    }
    if (!sourceCode) {
      setError("保存前请先填写 GLSL 代码。");
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
        sourcePrompt: sourcePrompt || "手动保存收藏",
        promptPreview: sourcePrompt || finalName,
        code: sourceCode,
        coverImageDataUrl,
      });
      setSaveNotice(`已保存新收藏：${result.favorite.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存收藏失败");
    } finally {
      setSaveLoading(false);
    }
  }

  const canRender = !loading && (createMode || Boolean(favorite));

  return (
    <main className="favorite-detail-shell">
      <header className="favorite-detail-header">
        <div>
          <h1>{createMode ? "新建收藏" : favorite?.name || "收藏详情"}</h1>
          {!createMode && favorite ? <p>{new Date(favorite.createdAt).toLocaleString()}</p> : null}
          {createMode ? <p>手动输入 GLSL，命名后保存为新收藏。</p> : null}
        </div>
      </header>

      {loading ? <div className="favorites-empty">加载中...</div> : null}
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
              {paused ? "播放" : "暂停"}
            </button>
            {compileError ? <pre className="compile-error">{compileError}</pre> : null}
          </div>

          <div className="favorite-detail-editor-pane">
            <div className="favorite-detail-editor-title">保存设置</div>
            <div className="favorite-save-row">
              <input
                type="text"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="收藏名称"
                className="favorite-name-input"
                disabled={saveLoading}
              />
              <button type="button" onClick={handleSaveAsFavorite} disabled={saveLoading || !editorCode.trim()}>
                {saveLoading ? "保存中..." : "保存"}
              </button>
            </div>
            <textarea
              className="favorite-prompt-input"
              value={sourcePromptInput}
              onChange={(event) => setSourcePromptInput(event.target.value)}
              rows={3}
              placeholder="用于归档的描述（可选）"
              disabled={saveLoading}
            />

            <div className="favorite-detail-editor-title">GLSL 代码（临时编辑，不会覆盖原收藏）</div>
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
                编译运行
              </button>
              <button
                type="button"
                onClick={handleDebugCode}
                disabled={!editorCode.trim() || debugLoading}
              >
                {debugLoading ? "debug中..." : "代码debug"}
              </button>
            </div>
            {dirty ? <div className="editor-notice">你已修改代码，直接关闭页面会丢失这些临时改动。</div> : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
