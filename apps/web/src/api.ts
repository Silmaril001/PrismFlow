export type Mode = "shader_glsl" | "pbr_texture";
export type LlmChannel = "rightcode" | "openrouter";
export type IdeationAssetKind = "image" | "video";

export interface ReferenceImageInput {
  dataUrl: string;
}

export interface Session {
  id: string;
  projectId: string;
  mode: Mode;
  status: "active" | "archived";
  createdAt: string;
}

export interface Revision {
  id: string;
  sessionId: string;
  parentRevisionId: string | null;
  prompt: string;
  llmModel: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  llmLatencyMs: number;
  compileStatus: "pass" | "fail" | "unchecked";
  compileErrors: string[];
  createdAt: string;
}

export interface IdeationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  extractedPrompt?: string;
  createdAt: string;
}

export interface IdeationAssetMeta {
  id: string;
  kind: IdeationAssetKind;
  fileName: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
}

export interface FavoriteSummary {
  id: string;
  name: string;
  coverImageDataUrl: string;
  createdAt: string;
}

export interface FavoriteDetail extends FavoriteSummary {
  sourcePrompt: string;
  promptPreview: string;
  code: string;
  revisionId?: string;
  sessionId?: string;
  instructionFileName: string;
  codeFileName: string;
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function createSession(mode: Mode): Promise<Session> {
  const data = await request<{ session: Session }>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });

  return data.session;
}

export async function sendMessage(
  sessionId: string,
  content: string,
  options?: {
    startNewShader?: boolean;
    currentCode?: string;
    referenceImages?: ReferenceImageInput[];
    channel?: LlmChannel;
    model?: string;
    baseUrl?: string;
    debugMode?: boolean;
    previewCompileErrors?: string[];
  },
): Promise<{
  revision: Revision;
  code: string;
  startedNewShader?: boolean;
}> {
  return request<{ revision: Revision; code: string; startedNewShader?: boolean }>(
    `/v1/sessions/${sessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content,
        startNewShader: options?.startNewShader ?? false,
        currentCode: options?.currentCode,
        referenceImages: options?.referenceImages ?? [],
        channel: options?.channel ?? "rightcode",
        model: options?.model,
        baseUrl: options?.baseUrl,
        debugMode: options?.debugMode ?? false,
        previewCompileErrors: options?.previewCompileErrors ?? [],
      }),
    },
  );
}

export async function exportRevision(
  revisionId: string,
): Promise<{ filename: string; mimeType: string; content: string }> {
  return request<{ filename: string; mimeType: string; content: string }>(
    `/v1/revisions/${revisionId}/export`,
    {
      method: "POST",
      body: JSON.stringify({ format: "glsl" }),
    },
  );
}

export async function getIdeationState(sessionId: string): Promise<{
  messages: IdeationMessage[];
  asset: IdeationAssetMeta | null;
  linkedReferenceImages: string[];
}> {
  return request<{ messages: IdeationMessage[]; asset: IdeationAssetMeta | null; linkedReferenceImages: string[] }>(
    `/v1/sessions/${sessionId}/ideation/state`,
    { method: "GET" },
  );
}

export async function sendIdeationMessage(
  sessionId: string,
  payload: {
    content?: string;
    asset?: {
      fileName: string;
      mimeType: string;
      dataUrl?: string;
      dataBase64?: string;
    };
  },
): Promise<{
  userMessage: IdeationMessage;
  assistantMessage: IdeationMessage;
  asset: IdeationAssetMeta | null;
  extractedPrompt: string;
  analysis: string;
  model: {
    requested: string;
    effective: string;
    fallbackUsed: boolean;
    latencyMs: number;
  };
  linkedReferenceImages: string[];
}> {
  return request(`/v1/sessions/${sessionId}/ideation/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: payload.content ?? "",
      asset: payload.asset,
    }),
  });
}

export async function resetIdeation(sessionId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/v1/sessions/${sessionId}/ideation/reset`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function optimizeCurrentShader(
  sessionId: string,
  payload: {
    targetPrompt: string;
    currentCode: string;
    previewFrameDataUrl: string;
    channel?: LlmChannel;
    model?: string;
    baseUrl?: string;
    parentRevisionId?: string;
  },
): Promise<{
  revision: Revision;
  code: string;
  optimize: {
    analysis: string;
    prompt: string;
    model: {
      requested: string;
      effective: string;
      fallbackUsed: boolean;
      latencyMs: number;
    };
    assetUsed: boolean;
  };
}> {
  return request(`/v1/sessions/${sessionId}/optimize-current`, {
    method: "POST",
    body: JSON.stringify({
      targetPrompt: payload.targetPrompt,
      currentCode: payload.currentCode,
      previewFrameDataUrl: payload.previewFrameDataUrl,
      channel: payload.channel ?? "rightcode",
      model: payload.model,
      baseUrl: payload.baseUrl,
      parentRevisionId: payload.parentRevisionId,
    }),
  });
}

export async function requestOptimizeSuggestion(
  sessionId: string,
  payload: {
    targetPrompt: string;
    currentCode: string;
    previewFrameDataUrl: string;
    userInstruction?: string;
  },
): Promise<{
  optimize: {
    analysis: string;
    prompt: string;
    model: {
      requested: string;
      effective: string;
      fallbackUsed: boolean;
      latencyMs: number;
    };
    assetUsed: boolean;
  };
}> {
  return request(`/v1/sessions/${sessionId}/optimize/suggest`, {
    method: "POST",
    body: JSON.stringify({
      targetPrompt: payload.targetPrompt,
      currentCode: payload.currentCode,
      previewFrameDataUrl: payload.previewFrameDataUrl,
      userInstruction: payload.userInstruction,
    }),
  });
}

export async function applyOptimizePrompt(
  sessionId: string,
  payload: {
    optimizePrompt: string;
    currentCode: string;
    channel?: LlmChannel;
    model?: string;
    baseUrl?: string;
    parentRevisionId?: string;
  },
): Promise<{
  revision: Revision;
  code: string;
}> {
  return request(`/v1/sessions/${sessionId}/optimize/apply`, {
    method: "POST",
    body: JSON.stringify({
      optimizePrompt: payload.optimizePrompt,
      currentCode: payload.currentCode,
      channel: payload.channel ?? "rightcode",
      model: payload.model,
      baseUrl: payload.baseUrl,
      parentRevisionId: payload.parentRevisionId,
    }),
  });
}

export async function createFavorite(payload: {
  name?: string;
  sourcePrompt: string;
  promptPreview?: string;
  code: string;
  coverImageDataUrl: string;
  revisionId?: string;
  sessionId?: string;
}): Promise<{
  favorite: FavoriteDetail;
  namer: {
    requestedModel: string;
    fallbackModel: string | null;
  };
}> {
  return request("/v1/favorites", {
    method: "POST",
    body: JSON.stringify({
      sourcePrompt: payload.sourcePrompt,
      promptPreview: payload.promptPreview,
      code: payload.code,
      coverImageDataUrl: payload.coverImageDataUrl,
      revisionId: payload.revisionId,
      sessionId: payload.sessionId,
      name: payload.name,
    }),
  });
}

export async function listFavorites(): Promise<FavoriteSummary[]> {
  const data = await request<{ favorites: FavoriteSummary[] }>("/v1/favorites", {
    method: "GET",
  });
  return data.favorites;
}

export async function getFavoriteById(id: string): Promise<FavoriteDetail> {
  const data = await request<{ favorite: FavoriteDetail }>(`/v1/favorites/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  return data.favorite;
}
