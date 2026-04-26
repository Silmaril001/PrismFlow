import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent } from "undici";
import { config } from "../config.js";
import { buildOptimizeSystemPrompt } from "./promptTemplates.js";

interface OptimizeAssetInput {
  mimeType: string;
  dataBase64: string;
}

export interface GeminiOptimizeRequest {
  targetPrompt: string;
  currentCode: string;
  previewFrameDataUrl: string;
  userInstruction?: string;
  ideationAsset?: OptimizeAssetInput;
}

export interface GeminiOptimizeResponse {
  analysis: string;
  optimizePrompt: string;
  rawText: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

interface GeminiContent {
  role: "user";
  parts: GeminiPart[];
}

interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

const proxyAgentCache = new Map<string, any>();
const MAX_CODE_CONTEXT_CHARS = 30_000;

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
  const base = normalizeGeminiBaseUrl(config.geminiOptimizeBaseUrl);
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
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

  return parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseOptimizeJson(rawText: string): { analysis: string; optimizePrompt: string } {
  const trimmed = rawText.trim();
  const fromJson = (value: string): { analysis: string; optimizePrompt: string } | null => {
    try {
      const parsed = JSON.parse(value) as { analysis?: unknown; optimize_prompt?: unknown };
      const analysis = typeof parsed.analysis === "string" ? parsed.analysis.trim() : "";
      const optimizePrompt =
        typeof parsed.optimize_prompt === "string" ? parsed.optimize_prompt.trim() : "";
      if (analysis || optimizePrompt) {
        return {
          analysis: analysis || "Model did not return an analysis field.",
          optimizePrompt: optimizePrompt || analysis || value.trim(),
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
    analysis: "Model returned non-JSON output. Using raw text fallback.",
    optimizePrompt: trimmed,
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
  const tempDir = mkdtempSync(join(tmpdir(), "shader-optimize-video-"));
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
  const tempDir = mkdtempSync(join(tmpdir(), "shader-optimize-video-input-"));
  const inputPath = join(tempDir, `input${extensionFromVideoMimeType(mimeType)}`);
  try {
    writeFileSync(inputPath, Buffer.from(dataBase64, "base64"));
    return await extractVideoFramesAsParts(inputPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = dataUrl.trim().match(/^data:(image\/[^;,]+);base64,(.+)$/i);
  if (!match) {
    throw new Error("previewFrameDataUrl must be a valid data:image/* base64 URL.");
  }
  return {
    mimeType: match[1]!,
    base64: match[2]!,
  };
}

function buildUserText(targetPrompt: string, currentCode: string, userInstruction?: string): string {
  const normalizedPrompt = targetPrompt.trim();
  const normalizedCode = currentCode.trim();
  const normalizedInstruction = userInstruction?.trim() ?? "";
  const codeForContext =
    normalizedCode.length > MAX_CODE_CONTEXT_CHARS
      ? `${normalizedCode.slice(0, MAX_CODE_CONTEXT_CHARS)}\n/* ... truncated ... */`
      : normalizedCode;

  const userInstructionSection =
    normalizedInstruction.length > 0
      ? [
          "User additional instruction (highest priority):",
          normalizedInstruction,
          "Execution rule: if this instruction conflicts with reference image/video, prioritize the user additional instruction.",
        ].join("\n")
      : "User additional instruction: none. Please determine the best optimization plan using target description, screenshot, asset, and current code.";

  return [
    "Please compare the target and current result, then output optimization guidance.",
    `Target Description:\n${normalizedPrompt || "(empty)"}`,
    userInstructionSection,
    `Current GLSL Code:\n${codeForContext || "(empty)"}`,
    "A screenshot at t=2s for the current result is attached. Please diagnose based on both screenshot and code.",
  ].join("\n\n");
}

export async function runGeminiOptimize(
  request: GeminiOptimizeRequest,
): Promise<GeminiOptimizeResponse> {
  const startedAt = Date.now();
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY/OPENAI_API_KEY is missing for optimize flow.");
  }

  const systemPrompt = buildOptimizeSystemPrompt();
  const userParts: GeminiPart[] = [
    {
      text: buildUserText(request.targetPrompt, request.currentCode, request.userInstruction),
    },
  ];
  const previewImage = parseImageDataUrl(request.previewFrameDataUrl);
  userParts.push({
    inline_data: {
      mime_type: previewImage.mimeType,
      data: previewImage.base64,
    },
  });

  if (request.ideationAsset) {
    if (isVideoMimeType(request.ideationAsset.mimeType)) {
      const frameParts = await extractVideoFramesAsPartsFromBase64(
        request.ideationAsset.mimeType,
        request.ideationAsset.dataBase64,
      );
      userParts.push({
        text: `Additional reference: ideation asset is a video. ${frameParts.length} frame(s) were auto-extracted.`,
      });
      userParts.push(...frameParts);
    } else {
      userParts.push({
        text: "Additional reference: ideation asset is an image.",
      });
      userParts.push({
        inline_data: {
          mime_type: request.ideationAsset.mimeType,
          data: request.ideationAsset.dataBase64,
        },
      });
    }
  }

  const contents: GeminiContent[] = [
    {
      role: "user",
      parts: userParts,
    },
  ];

  const generationConfig: Record<string, unknown> = {
    temperature: 0.25,
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

  const requestedModel = config.geminiOptimizeModel;
  const fallbackModel = config.geminiOptimizeFallbackModel;

  const attempts: Array<{ model: string; timeoutMs: number; isFallback: boolean }> = [
    {
      model: requestedModel,
      timeoutMs: config.geminiOptimizeTimeoutMs,
      isFallback: false,
    },
  ];
  if (fallbackModel && fallbackModel !== requestedModel) {
    attempts.push({
      model: fallbackModel,
      timeoutMs: config.geminiOptimizeFallbackTimeoutMs,
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
        throw new Error(`Gemini optimize request failed (${response.status}): ${response.body}`);
      }

      const rawText = extractGeminiText(response.body);
      if (!rawText) {
        throw new Error("Gemini optimize response did not include text.");
      }

      const parsed = parseOptimizeJson(rawText);
      return {
        analysis: parsed.analysis,
        optimizePrompt: parsed.optimizePrompt,
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

  throw new Error(lastError?.message ?? "Gemini optimize request failed.");
}
