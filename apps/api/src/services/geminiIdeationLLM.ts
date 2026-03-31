import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent } from "undici";
import { config } from "../config.js";
import { buildIdeationSystemPrompt } from "./promptTemplates.js";

interface IdeationHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

interface IdeationAssetInput {
  mimeType: string;
  dataBase64: string;
}

interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiIdeationRequest {
  userMessage: string;
  history: IdeationHistoryMessage[];
  asset?: IdeationAssetInput;
}

export interface GeminiIdeationResponse {
  analysis: string;
  glslPrompt: string;
  rawText: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

const proxyAgentCache = new Map<string, any>();

function parseNoProxyEntries(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function shouldBypassProxy(hostname: string): boolean {
  const noProxyRaw = process.env.NO_PROXY || process.env.no_proxy || "";
  const entries = parseNoProxyEntries(noProxyRaw);
  if (entries.length === 0) {
    return false;
  }
  const host = hostname.toLowerCase();
  return entries.some((entry) => {
    if (entry === "*") {
      return true;
    }
    if (entry.startsWith(".")) {
      return host.endsWith(entry);
    }
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function resolveProxyUrl(endpoint: string): string | undefined {
  const url = new URL(endpoint);
  if (shouldBypassProxy(url.hostname)) {
    return undefined;
  }
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;
  if (url.protocol === "https:") {
    return httpsProxy || allProxy || httpProxy || undefined;
  }
  return httpProxy || allProxy || httpsProxy || undefined;
}

function getProxyAgent(proxyUrl: string): any {
  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) {
    return cached;
  }
  const created = new ProxyAgent(proxyUrl);
  proxyAgentCache.set(proxyUrl, created);
  return created;
}

async function postJson(
  endpoint: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpResponse> {
  const hasLocalTimeout = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0;
  const controller = hasLocalTimeout ? new AbortController() : null;
  const timeoutHandle = hasLocalTimeout
    ? setTimeout(() => controller?.abort(), Number(timeoutMs))
    : null;

  try {
    const proxyUrl = resolveProxyUrl(endpoint);
    const init: any = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    };
    if (controller) {
      init.signal = controller.signal;
    }
    if (proxyUrl) {
      init.dispatcher = getProxyAgent(proxyUrl);
    }

    const response = await fetch(endpoint, init);
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${Number(timeoutMs)}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1beta$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/codex\/v1$/i.test(trimmed)) {
    return trimmed.replace(/\/codex\/v1$/i, "/v1beta");
  }
  if (/\/gemini$/i.test(trimmed)) {
    return `${trimmed}/v1beta`;
  }
  return `${trimmed}/v1beta`;
}

function buildEndpoint(model: string): string {
  const base = normalizeGeminiBaseUrl(config.geminiBaseUrl);
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
}

function mapHistoryToGeminiContents(history: IdeationHistoryMessage[]): GeminiContent[] {
  const normalized = history
    .slice(-12)
    .filter((item) => item.text.trim().length > 0)
    .map((item) => {
      const role: "user" | "model" = item.role === "assistant" ? "model" : "user";
      return {
        role,
        parts: [{ text: item.text }],
      };
    });
  return normalized;
}

function shouldFallback(status: number, body: string): boolean {
  if (status === 429 || status >= 500) {
    return true;
  }
  return /MODEL_CAPACITY_EXHAUSTED|capacity exhausted|RESOURCE_EXHAUSTED/i.test(body);
}

function extractGeminiText(responseBody: string): string {
  const parsed = JSON.parse(responseBody) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>;
      };
    }>;
  };

  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const cleanText = parts
    .filter((part) => !part.thought && !part.thoughtSignature)
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (cleanText.length > 0) {
    return cleanText;
  }

  // Compatibility fallback for providers that only return text in thought parts.
  return parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseIdeationJson(rawText: string): { analysis: string; glslPrompt: string } {
  const trimmed = rawText.trim();
  const fromJson = (value: string): { analysis: string; glslPrompt: string } | null => {
    try {
      const parsed = JSON.parse(value) as { analysis?: unknown; glsl_prompt?: unknown };
      const analysis = typeof parsed.analysis === "string" ? parsed.analysis.trim() : "";
      const glslPrompt = typeof parsed.glsl_prompt === "string" ? parsed.glsl_prompt.trim() : "";
      if (analysis || glslPrompt) {
        return {
          analysis: analysis || "模型未返回分析字段。",
          glslPrompt: glslPrompt || analysis || value.trim(),
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = fromJson(trimmed);
  if (direct) {
    return direct;
  }

  const jsonBlock = trimmed.match(/\{[\s\S]*\}/);
  if (jsonBlock) {
    const nested = fromJson(jsonBlock[0]);
    if (nested) {
      return nested;
    }
  }

  return {
    analysis: "模型返回非 JSON，已按原文兜底。",
    glslPrompt: trimmed,
  };
}

function isVideoMimeType(mimeType: string): boolean {
  return /^video\//i.test(mimeType);
}

function runProcess(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${bin} exited with code ${code}. ${stderr.trim()}`.trim()));
    });
  });
}

async function extractVideoFramesAsParts(storagePath: string): Promise<GeminiPart[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "shader-ideation-video-"));
  const outputPattern = join(tempDir, "frame_%03d.jpg");
  const vf = `fps=${config.geminiVideoFrameFps},scale=${config.geminiVideoFrameWidth}:-2`;

  try {
    await runProcess(config.ffmpegBin, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      storagePath,
      "-vf",
      vf,
      "-q:v",
      "4",
      outputPattern,
    ]);

    const frameNames = readdirSync(tempDir)
      .filter((name) => name.endsWith(".jpg"))
      .sort()
      .slice(0, config.geminiVideoFrameMaxCount);

    if (frameNames.length === 0) {
      throw new Error("Video frame extraction produced no frames.");
    }

    return frameNames.map((name) => ({
      inline_data: {
        mime_type: "image/jpeg",
        data: readFileSync(join(tempDir, name)).toString("base64"),
      },
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Video preprocessing failed: ${reason}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extensionFromVideoMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("quicktime")) return ".mov";
  if (normalized.includes("mp4")) return ".mp4";
  return ".video";
}

async function extractVideoFramesAsPartsFromBase64(
  mimeType: string,
  dataBase64: string,
): Promise<GeminiPart[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "shader-ideation-video-input-"));
  const inputPath = join(tempDir, `input${extensionFromVideoMimeType(mimeType)}`);
  try {
    writeFileSync(inputPath, Buffer.from(dataBase64, "base64"));
    return await extractVideoFramesAsParts(inputPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function partToDataUrl(part: GeminiPart): string | null {
  if (!part.inline_data?.mime_type || !part.inline_data?.data) {
    return null;
  }
  return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
}

export async function buildLinkedReferenceDataUrls(asset: IdeationAssetInput): Promise<string[]> {
  if (isVideoMimeType(asset.mimeType)) {
    const parts = await extractVideoFramesAsPartsFromBase64(asset.mimeType, asset.dataBase64);
    return parts
      .map(partToDataUrl)
      .filter((item): item is string => Boolean(item));
  }

  return [`data:${asset.mimeType};base64,${asset.dataBase64}`];
}

export async function runGeminiIdeation(
  request: GeminiIdeationRequest,
): Promise<GeminiIdeationResponse> {
  const startedAt = Date.now();
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY/OPENAI_API_KEY is missing for ideation flow.");
  }

  const systemPrompt = buildIdeationSystemPrompt();
  const contents = mapHistoryToGeminiContents(request.history);
  const userParts: GeminiPart[] = [{ text: request.userMessage.trim() || "请继续细化上一次需求。" }];
  const isVideoAsset = Boolean(request.asset && isVideoMimeType(request.asset.mimeType));

  if (request.asset) {
    if (isVideoAsset) {
      const frameParts = await extractVideoFramesAsPartsFromBase64(
        request.asset.mimeType,
        request.asset.dataBase64,
      );
      userParts.push({
        text: `补充：输入素材为视频。服务端已自动按每秒 ${config.geminiVideoFrameFps} 帧抽取 ${frameParts.length} 张关键帧用于分析。`,
      });
      userParts.push(...frameParts);
    } else {
      userParts.push({
        inline_data: {
          mime_type: request.asset.mimeType,
          data: request.asset.dataBase64,
        },
      });
    }
  }

  contents.push({
    role: "user",
    parts: userParts,
  });

  const generationConfig: Record<string, unknown> = {
    temperature: 0.35,
  };
  if (config.geminiMaxOutputTokens > 0) {
    generationConfig.maxOutputTokens = config.geminiMaxOutputTokens;
  }

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig,
  };

  const requestedModel = isVideoAsset ? config.geminiVideoModel : config.geminiModel;
  const fallbackModel = isVideoAsset
    ? config.geminiVideoFallbackModel
    : config.geminiFallbackModel;

  const attempts: Array<{ model: string; timeoutMs: number; isFallback: boolean }> = [
    {
      model: requestedModel,
      timeoutMs: config.geminiTimeoutMs,
      isFallback: false,
    },
  ];
  if (fallbackModel && fallbackModel !== requestedModel) {
    attempts.push({
      model: fallbackModel,
      timeoutMs: config.geminiFallbackTimeoutMs,
      isFallback: true,
    });
  }

  let lastError: Error | null = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i]!;
    const endpoint = buildEndpoint(attempt.model);
    try {
      const response = await postJson(
        endpoint,
        payload,
        {
          "Content-Type": "application/json",
          "x-goog-api-key": config.geminiApiKey,
        },
        attempt.timeoutMs,
      );

      if (!response.ok) {
        if (i < attempts.length - 1 && shouldFallback(response.status, response.body)) {
          continue;
        }
        throw new Error(`Gemini request failed (${response.status}): ${response.body}`);
      }

      const rawText = extractGeminiText(response.body);
      if (!rawText) {
        throw new Error("Gemini response did not include text.");
      }
      const parsed = parseIdeationJson(rawText);
      return {
        analysis: parsed.analysis,
        glslPrompt: parsed.glslPrompt,
        rawText,
        requestedModel,
        effectiveModel: attempt.model,
        fallbackUsed: attempt.isFallback,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      lastError = reason;
      if (i < attempts.length - 1 && /timed out|capacity exhausted|RESOURCE_EXHAUSTED/i.test(reason.message)) {
        continue;
      }
    }
  }

  throw new Error(lastError?.message ?? "Gemini ideation request failed.");
}
