import { config } from "../config.js";
import type { LlmChannel } from "../models.js";
import { DEFAULT_FRAGMENT_SHADER } from "./defaultShader.js";
import { buildShaderSystemPrompt } from "./promptTemplates.js";
import { ProxyAgent } from "undici";

export interface ShaderGenerationParams {
  userIntent: string;
  referenceImageDataUrls?: string[];
  modelOverride?: string;
  baseUrlOverride?: string;
  channelOverride?: LlmChannel;
  debugMode?: boolean;
  previousCode?: string;
  compileErrors?: string[];
}

export interface ShaderGenerationResult {
  code: string;
  model: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

function stripCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:glsl)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : raw.trim();
}

type ChatMessageContentPart = string | { type?: string; text?: string; content?: unknown };

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of content as ChatMessageContentPart[]) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      if (typeof part.text === "string" && part.text.length > 0) {
        textParts.push(part.text);
        continue;
      }
      if (typeof part.content === "string" && part.content.length > 0) {
        textParts.push(part.content);
      }
    }
  }

  return textParts.join("\n").trim();
}

interface DirectHttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

const proxyAgentCache = new Map<string, any>();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

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
  timeoutMs: number,
): Promise<DirectHttpResponse> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proxyUrl = resolveProxyUrl(endpoint);
    const fetchInit: any = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    };
    if (proxyUrl) {
      fetchInit.dispatcher = getProxyAgent(proxyUrl);
    }

    const response = await fetch(endpoint, {
      ...fetchInit,
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

interface LlmTransportConfig {
  channel: LlmChannel;
  apiKey?: string;
  model: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
}

function resolveTransportConfig(params: ShaderGenerationParams): LlmTransportConfig {
  if (params.debugMode) {
    return {
      channel: "rightcode",
      apiKey: config.openaiApiKey,
      model: params.modelOverride?.trim() || config.openaiDebugModel,
      baseUrl: params.baseUrlOverride?.trim() || config.openaiDebugBaseUrl,
    };
  }

  if (params.channelOverride === "openrouter") {
    const extraHeaders: Record<string, string> = {};
    if (config.openrouterHttpReferer) {
      extraHeaders["HTTP-Referer"] = config.openrouterHttpReferer;
    }
    if (config.openrouterAppName) {
      extraHeaders["X-Title"] = config.openrouterAppName;
    }
    return {
      channel: "openrouter",
      apiKey: config.openrouterApiKey,
      model: params.modelOverride?.trim() || config.openrouterModel,
      baseUrl: config.openrouterBaseUrl,
      extraHeaders,
    };
  }

  return {
    channel: "rightcode",
    apiKey: config.openaiApiKey,
    model: params.modelOverride?.trim() || config.openaiModel,
    baseUrl: params.baseUrlOverride?.trim() || config.openaiBaseUrl,
  };
}

export function normalizeToShadertoyContract(raw: string): string {
  let normalized = raw.trim();

  // Never keep macro redefinitions for Shadertoy built-ins.
  normalized = normalized.replace(/^\s*#define\s+iTime\b.*$/gm, "");
  normalized = normalized.replace(/^\s*#define\s+iResolution\b.*$/gm, "");

  // Remove Shadertoy wrapper main if present.
  normalized = normalized.replace(
    /void\s+main\s*\(\s*\)\s*\{\s*mainImage\s*\(\s*gl_FragColor\s*,\s*gl_FragCoord\.xy\s*\)\s*;\s*\}/g,
    "",
  );

  const hasMainImage = /void\s+mainImage\s*\(/.test(normalized);
  const hasMain = /void\s+main\s*\(\s*\)/.test(normalized);
  if (!hasMainImage && hasMain) {
    normalized = normalized.replace(
      /void\s+main\s*\(\s*\)/,
      "void mainImage(out vec4 fragColor, in vec2 fragCoord)",
    );
    normalized = normalized.replace(/\bgl_FragCoord\.xy\b/g, "fragCoord");
    normalized = normalized.replace(/\bgl_FragCoord\b/g, "vec4(fragCoord, 0.0, 1.0)");
    normalized = normalized.replace(/\bgl_FragColor\b/g, "fragColor");
  }

  normalized = normalized.replace(/^\s*uniform\s+float\s+u_time\s*;\s*$/gm, "");
  normalized = normalized.replace(/^\s*uniform\s+vec2\s+u_resolution\s*;\s*$/gm, "");
  normalized = normalized.replace(/^\s*uniform\s+float\s+iTime\s*;\s*$/gm, "");
  normalized = normalized.replace(/^\s*uniform\s+vec[234]\s+iResolution\s*;\s*$/gm, "");

  normalized = normalized.replace(/\bu_resolution\.xy\b/g, "iResolution.xy");
  normalized = normalized.replace(/\bu_resolution\b/g, "iResolution.xy");
  normalized = normalized.replace(/\bu_time\b/g, "iTime");

  if (!/^\s*precision\s+(lowp|mediump|highp)\s+float\s*;/m.test(normalized)) {
    const versionMatch = normalized.match(/^\s*#version[^\n]*\n?/);
    if (versionMatch) {
      const versionLine = versionMatch[0];
      normalized = `${versionLine}precision highp float;\n${normalized.slice(versionLine.length)}`;
    } else {
      normalized = `precision highp float;\n\n${normalized}`;
    }
  }

  normalized = normalized.replace(/\n{3,}/g, "\n\n").trim();
  return `${normalized}\n`;
}

function fallbackShader(userIntent: string): string {
  const intent = userIntent.toLowerCase();
  const warm = /red|orange|fire|lava|heat|glow/.test(intent);
  const cool = /blue|water|ice|ocean/.test(intent);

  if (warm) {
    return `precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord.xy / iResolution.xy;
  float wave = 0.5 + 0.5 * sin(uv.y * 16.0 - iTime * 2.0);
  vec3 color = mix(vec3(0.2, 0.02, 0.01), vec3(1.0, 0.35, 0.1), wave);
  fragColor = vec4(color, 1.0);
}
`;
  }

  if (cool) {
    return DEFAULT_FRAGMENT_SHADER;
  }

  return `precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);
  float radius = length(uv);
  float ring = smoothstep(0.35, 0.33, abs(sin(radius * 18.0 - iTime * 2.5)));
  vec3 color = mix(vec3(0.04, 0.05, 0.1), vec3(0.55, 0.9, 0.95), ring);
  fragColor = vec4(color, 1.0);
}
`;
}

export async function generateShaderWithOpenAI(
  params: ShaderGenerationParams,
): Promise<ShaderGenerationResult> {
  const startedAt = Date.now();
  const transport = resolveTransportConfig(params);

  if (!transport.apiKey) {
    return {
      code: normalizeToShadertoyContract(fallbackShader(params.userIntent)),
      model: `fallback-local-template-${transport.channel}`,
      requestedModel: `fallback-local-template-${transport.channel}`,
      effectiveModel: `fallback-local-template-${transport.channel}`,
      fallbackUsed: false,
      latencyMs: Date.now() - startedAt,
    };
  }

  const systemPrompt = buildShaderSystemPrompt(Boolean(params.debugMode));

  const normalizedPreviousCode = params.previousCode
    ? normalizeToShadertoyContract(params.previousCode)
    : undefined;
  const referenceImageDataUrls = (params.referenceImageDataUrls ?? []).slice(0, 5);
  const cleanedIntent = params.userIntent.trim();
  const userRequestText =
    cleanedIntent.length > 0
      ? `Request: ${cleanedIntent}`
      : "Request: Analyze the provided reference image(s) and produce a shader that matches their visual style.";

  const userSections = [
    params.debugMode ? `Debug task. ${userRequestText}` : userRequestText,
    referenceImageDataUrls.length > 0
      ? `Reference images attached: ${referenceImageDataUrls.length}.`
      : "",
    normalizedPreviousCode ? `Current shader:\n${normalizedPreviousCode}` : "",
    params.compileErrors && params.compileErrors.length > 0
      ? `Previous compile errors:\n- ${params.compileErrors.join("\n- ")}`
      : "",
    "If this is an edit request, preserve style and only apply requested changes.",
  ].filter(Boolean);
  const userContent: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: userSections.join("\n\n") }];
  for (const dataUrl of referenceImageDataUrls) {
    userContent.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }

  const requestBody = {
    temperature: 0.2,
    max_tokens: config.openaiMaxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const requestedModel = transport.model;
  const requestedBaseUrl = transport.baseUrl;

  const fetchCompletion = async (model: string, timeoutMs: number): Promise<DirectHttpResponse> =>
    postJson(
      `${normalizeBaseUrl(requestedBaseUrl)}/chat/completions`,
      {
        model,
        ...requestBody,
      },
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${transport.apiKey}`,
        ...(transport.extraHeaders ?? {}),
      },
      timeoutMs,
    );

  let response: DirectHttpResponse;
  try {
    response = await fetchCompletion(requestedModel, config.openaiTimeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network failure";
    throw new Error(
      `LLM endpoint unreachable (${requestedBaseUrl}). Channel: ${transport.channel}, model: ${requestedModel}, timeout: ${config.openaiTimeoutMs}ms. Check channel config and network/proxy settings. Root cause: ${reason}`,
    );
  }

  if (!response.ok) {
    throw new Error(`LLM request failed (${response.status}): ${response.body}`);
  }

  const data = JSON.parse(response.body) as {
    choices?: Array<{
      message?: {
        content?: unknown;
        refusal?: string | null;
        tool_calls?: unknown[];
      };
      finish_reason?: string | null;
    }>;
    model?: string;
  };

  const firstChoice = data.choices?.[0];
  const content = extractTextFromMessageContent(firstChoice?.message?.content);
  if (!content || content.trim().length === 0) {
    const refusal = firstChoice?.message?.refusal;
    const finishReason = firstChoice?.finish_reason ?? "unknown";
    const hasToolCalls = Array.isArray(firstChoice?.message?.tool_calls) &&
      firstChoice!.message!.tool_calls!.length > 0;
    const detail = [
      `finish_reason=${finishReason}`,
      refusal ? `refusal=${refusal}` : "",
      hasToolCalls ? "tool_calls=present" : "",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `LLM returned empty message content${detail ? ` (${detail})` : ""}. This can happen on provider-side structured/tool responses.`,
    );
  }

  return {
    code: normalizeToShadertoyContract(stripCodeFence(content)),
    model: data.model ?? requestedModel,
    requestedModel,
    effectiveModel: requestedModel,
    fallbackUsed: false,
    latencyMs: Date.now() - startedAt,
  };
}
