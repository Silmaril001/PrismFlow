import { ProxyAgent } from "undici";
import { config } from "../config.js";
import { buildFavoriteNamerSystemPrompt } from "./promptTemplates.js";

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
  timeoutMs: number,
): Promise<HttpResponse> {
  const hasLocalTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const controller = hasLocalTimeout ? new AbortController() : null;
  const timeoutHandle = hasLocalTimeout ? setTimeout(() => controller?.abort(), timeoutMs) : null;

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
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildEndpoint(): string {
  const base = normalizeBaseUrl(config.favoriteNamerBaseUrl);
  return `${base}/chat/completions`;
}

function extractText(responseBody: string): string {
  const parsed = JSON.parse(responseBody) as {
    choices?: Array<{
      message?: {
        content?:
          | string
          | Array<{
              type?: string;
              text?: string;
            }>;
      };
    }>;
  };

  const messageContent = parsed.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent.trim();
  }
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function parseResult(rawText: string): { name: string; promptPreview: string } {
  const trimmed = rawText.trim();
  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; prompt_preview?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const promptPreview =
      typeof parsed.prompt_preview === "string" ? parsed.prompt_preview.trim() : "";
    return {
      name: name || "未命名Shader",
      promptPreview: promptPreview || "无摘要",
    };
  } catch {
    return {
      name: "未命名Shader",
      promptPreview: trimmed || "无摘要",
    };
  }
}

export async function nameFavoriteFromGemini(input: {
  sourcePrompt: string;
  code: string;
}): Promise<{
  name: string;
  promptPreview: string;
}> {
  if (!config.favoriteNamerApiKey) {
    return {
      name: "未命名Shader",
      promptPreview: input.sourcePrompt.trim() || "无摘要",
    };
  }

  const systemPrompt = buildFavoriteNamerSystemPrompt();
  const requestedModel = config.favoriteNamerModel;
  const fallbackModel = config.favoriteNamerFallbackModel;
  const attempts: Array<{ model: string; timeoutMs: number }> = [
    { model: requestedModel, timeoutMs: config.favoriteNamerTimeoutMs },
  ];
  if (fallbackModel && fallbackModel !== requestedModel) {
    attempts.push({ model: fallbackModel, timeoutMs: config.favoriteNamerFallbackTimeoutMs });
  }

  let lastError: Error | null = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i]!;
    const payload = {
      model: attempt.model,
      temperature: 0.2,
      max_tokens: 240,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            "请为这个收藏结果生成名字和提示词摘要。",
            `Source Prompt:\n${input.sourcePrompt.trim() || "（空）"}`,
            `GLSL Code:\n${input.code.trim().slice(0, 24000)}`,
          ].join("\n\n"),
        },
      ],
    };

    try {
      const response = await postJson(
        buildEndpoint(),
        payload,
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.favoriteNamerApiKey}`,
        },
        attempt.timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Favorite namer failed (${response.status}): ${response.body}`);
      }
      const rawText = extractText(response.body);
      if (!rawText) {
        throw new Error("Favorite namer returned empty text.");
      }
      return parseResult(rawText);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(lastError?.message ?? "Favorite namer failed.");
}
