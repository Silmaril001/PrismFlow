import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import type { LlmChannel, Mode } from "./models.js";
import { PipelineOrchestrator } from "./pipeline/orchestrator.js";
import { PbrPipeline } from "./pipeline/pbrPipeline.js";
import { ShaderPipeline } from "./pipeline/shaderPipeline.js";
import { PipelineUnavailableError } from "./pipeline/types.js";
import {
  createFavoritesStore,
} from "./services/favoritesStore.js";
import { buildLinkedReferenceDataUrls, runGeminiIdeation } from "./services/geminiIdeationLLM.js";
import { nameFavoriteFromGemini } from "./services/geminiFavoriteNamer.js";
import { runGeminiOptimize } from "./services/geminiOptimizeLLM.js";
import { createAppStoreFromConfig } from "./store.js";

const app = Fastify({
  logger: {
    level: "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "res.headers['set-cookie']",
      ],
      censor: "[REDACTED]",
    },
  },
  trustProxy: config.trustProxy,
  bodyLimit: 64 * 1024 * 1024,
});
const appStore = await createAppStoreFromConfig();
const orchestrator = new PipelineOrchestrator([
  new ShaderPipeline(),
  new PbrPipeline(),
]);
const favoritesStore = await createFavoritesStore();

const createSessionBody = z.object({
  mode: z.enum(["shader_glsl", "pbr_texture"]),
  projectId: z.string().optional(),
});

const messageBody = z
  .object({
    content: z.string().default(""),
    startNewShader: z.boolean().optional().default(false),
    currentCode: z.string().optional(),
    model: z.string().min(1).max(120).optional(),
    baseUrl: z.string().url().max(400).optional(),
    channel: z.enum(["rightcode", "openrouter"]).optional().default("rightcode"),
    debugMode: z.boolean().optional().default(false),
    previewCompileErrors: z.array(z.string().max(4000)).max(20).optional().default([]),
    referenceImages: z
      .array(
        z.object({
          dataUrl: z
            .string()
            .min(1)
            .max(4_000_000)
            .refine((value) => value.startsWith("data:image/"), {
              message: "referenceImages[].dataUrl must be a data:image/* URL.",
            }),
        }),
      )
      .max(5)
      .optional()
      .default([]),
  })
  .refine(
    (payload) => payload.content.trim().length > 0 || payload.referenceImages.length > 0,
    {
      message: "Either content or referenceImages is required.",
      path: ["content"],
    },
  );

const exportBody = z.object({
  format: z.enum(["glsl"]).default("glsl"),
});

const ideationAssetBody = z
  .object({
    fileName: z.string().min(1).max(240),
    mimeType: z.string().min(3).max(120),
    dataUrl: z.string().max(80_000_000).optional(),
    dataBase64: z.string().max(80_000_000).optional(),
  })
  .refine((value) => Boolean(value.dataUrl || value.dataBase64), {
    message: "asset requires dataUrl or dataBase64.",
  });

const ideationMessageBody = z
  .object({
    content: z.string().default(""),
    asset: ideationAssetBody.optional(),
  })
  .refine((payload) => payload.content.trim().length > 0 || Boolean(payload.asset), {
    message: "Either content or asset is required.",
    path: ["content"],
  });

const optimizeBody = z.object({
  targetPrompt: z.string().min(1).max(12000),
  currentCode: z.string().min(1).max(500000),
  previewFrameDataUrl: z
    .string()
    .min(1)
    .max(8_000_000)
    .refine((value) => value.startsWith("data:image/"), {
      message: "previewFrameDataUrl must be a data:image/* URL.",
    }),
  model: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().max(400).optional(),
  channel: z.enum(["rightcode", "openrouter"]).optional().default("rightcode"),
  parentRevisionId: z.string().min(1).max(120).optional(),
  userInstruction: z.string().max(4000).optional(),
});

const optimizeSuggestBody = z.object({
  targetPrompt: z.string().min(1).max(12000),
  currentCode: z.string().min(1).max(500000),
  previewFrameDataUrl: z
    .string()
    .min(1)
    .max(8_000_000)
    .refine((value) => value.startsWith("data:image/"), {
      message: "previewFrameDataUrl must be a data:image/* URL.",
    }),
  userInstruction: z.string().max(4000).optional(),
});

const optimizeApplyBody = z.object({
  optimizePrompt: z.string().min(1).max(12000),
  currentCode: z.string().min(1).max(500000),
  model: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().max(400).optional(),
  channel: z.enum(["rightcode", "openrouter"]).optional().default("rightcode"),
  parentRevisionId: z.string().min(1).max(120).optional(),
});

const favoriteCreateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  sourcePrompt: z.string().min(1).max(12000),
  promptPreview: z.string().min(1).max(3000).optional(),
  code: z.string().min(1).max(500000),
  coverImageDataUrl: z
    .string()
    .min(1)
    .max(8_000_000)
    .refine((value) => value.startsWith("data:image/"), {
      message: "coverImageDataUrl must be a data:image/* URL.",
    }),
  revisionId: z.string().min(1).max(120).optional(),
  sessionId: z.string().min(1).max(120).optional(),
});

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName);
  const cleaned = base.replace(/[^\w.\-]/g, "_");
  return cleaned.length > 0 ? cleaned : `asset-${Date.now()}`;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.startsWith("image/")) {
    if (mimeType.includes("png")) return ".png";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
    if (mimeType.includes("webp")) return ".webp";
    return ".img";
  }
  if (mimeType.startsWith("video/")) {
    if (mimeType.includes("webm")) return ".webm";
    if (mimeType.includes("mp4")) return ".mp4";
    if (mimeType.includes("quicktime")) return ".mov";
    return ".video";
  }
  return "";
}

function parseUploadedAsset(input: {
  fileName: string;
  mimeType: string;
  dataUrl?: string;
  dataBase64?: string;
}) {
  let mimeType = input.mimeType.trim();
  let base64 = input.dataBase64?.trim() ?? "";

  if (input.dataUrl && input.dataUrl.trim().length > 0) {
    const match = input.dataUrl.trim().match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) {
      throw new Error("asset.dataUrl is not a valid base64 data URL.");
    }
    mimeType = match[1] ?? mimeType;
    base64 = match[2] ?? "";
  }

  if (!/^image\/|^video\//.test(mimeType)) {
    throw new Error("Only image/* or video/* assets are supported.");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new Error("Asset payload is empty.");
  }
  if (bytes.length > 25 * 1024 * 1024) {
    throw new Error("Asset is too large (max 25MB).");
  }

  const kind: "image" | "video" = mimeType.startsWith("video/") ? "video" : "image";
  const safeFileName = sanitizeFileName(input.fileName);
  const extension = extname(safeFileName) || extensionFromMime(mimeType);
  return {
    kind,
    mimeType,
    bytes,
    safeFileName,
    extension,
  };
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function resolveParentRevision(
  sessionId: string,
  parentRevisionId?: string,
) {
  const parentRevision =
    parentRevisionId && parentRevisionId.trim().length > 0
      ? await appStore.getRevision(parentRevisionId.trim())
      : await appStore.getLatestRevisionBySession(sessionId);
  return parentRevision;
}

type RatePolicy = "heavy" | "generate" | "light";
type RequestWithTiming = FastifyRequest & {
  __startedAtMs?: number;
};

const rateCounterByKey = new Map<string, { windowStartMs: number; count: number }>();
const sessionInFlightById = new Map<string, number>();

const normalizedCorsExactOrigins = new Set<string>();
const normalizedCorsWildcardSuffixes: string[] = [];
for (const allowedOriginRaw of config.corsAllowOrigins) {
  const trimmed = allowedOriginRaw.trim();
  if (trimmed.length === 0) {
    continue;
  }
  if (trimmed.startsWith("*.")) {
    const suffix = trimmed.slice(2).toLowerCase();
    if (suffix.length > 0) {
      normalizedCorsWildcardSuffixes.push(suffix);
    }
    continue;
  }
  try {
    normalizedCorsExactOrigins.add(new URL(trimmed).origin.toLowerCase());
  } catch {
    normalizedCorsExactOrigins.add(trimmed.toLowerCase());
  }
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function isCorsOriginAllowed(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return false;
  }
  if (normalizedCorsExactOrigins.has(normalized)) {
    return true;
  }
  const host = new URL(normalized).hostname.toLowerCase();
  return normalizedCorsWildcardSuffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function getClientAddress(request: FastifyRequest): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0]!.trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0 && forwardedFor[0]?.trim()) {
    return forwardedFor[0].trim();
  }

  const realIp = request.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }
  if (Array.isArray(realIp) && realIp.length > 0 && realIp[0]?.trim()) {
    return realIp[0].trim();
  }

  return request.ip;
}

function consumeFixedWindowToken(params: {
  key: string;
  max: number;
  windowMs: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const current = rateCounterByKey.get(params.key);

  if (!current || now - current.windowStartMs >= params.windowMs) {
    rateCounterByKey.set(params.key, {
      windowStartMs: now,
      count: 1,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (current.count >= params.max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.windowStartMs + params.windowMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  policy: RatePolicy,
): boolean {
  if (!config.rateLimitEnabled) {
    return true;
  }

  const clientAddress = getClientAddress(request);
  if (policy === "heavy") {
    const burst = consumeFixedWindowToken({
      key: `heavy:burst:${scope}:${clientAddress}`,
      max: config.rateLimitHeavyBurstMax,
      windowMs: config.rateLimitHeavyBurstWindowSec * 1000,
    });
    if (!burst.allowed) {
      reply.header("Retry-After", String(burst.retryAfterSeconds));
      reply.status(429).send({
        error: `Too many requests for ${scope}. Please retry in ${burst.retryAfterSeconds}s.`,
        retryAfterSeconds: burst.retryAfterSeconds,
      });
      return false;
    }

    const sustained = consumeFixedWindowToken({
      key: `heavy:sustained:${scope}:${clientAddress}`,
      max: config.rateLimitHeavyMax,
      windowMs: config.rateLimitHeavyWindowSec * 1000,
    });
    if (!sustained.allowed) {
      reply.header("Retry-After", String(sustained.retryAfterSeconds));
      reply.status(429).send({
        error: `Too many requests for ${scope}. Please retry in ${sustained.retryAfterSeconds}s.`,
        retryAfterSeconds: sustained.retryAfterSeconds,
      });
      return false;
    }
    return true;
  }

  if (policy === "generate") {
    const burst = consumeFixedWindowToken({
      key: `generate:burst:${scope}:${clientAddress}`,
      max: config.rateLimitGenerateBurstMax,
      windowMs: config.rateLimitGenerateBurstWindowSec * 1000,
    });
    if (!burst.allowed) {
      reply.header("Retry-After", String(burst.retryAfterSeconds));
      reply.status(429).send({
        error: `Too many requests for ${scope}. Please retry in ${burst.retryAfterSeconds}s.`,
        retryAfterSeconds: burst.retryAfterSeconds,
      });
      return false;
    }

    const sustained = consumeFixedWindowToken({
      key: `generate:sustained:${scope}:${clientAddress}`,
      max: config.rateLimitGenerateMax,
      windowMs: config.rateLimitGenerateWindowSec * 1000,
    });
    if (!sustained.allowed) {
      reply.header("Retry-After", String(sustained.retryAfterSeconds));
      reply.status(429).send({
        error: `Too many requests for ${scope}. Please retry in ${sustained.retryAfterSeconds}s.`,
        retryAfterSeconds: sustained.retryAfterSeconds,
      });
      return false;
    }
    return true;
  }

  const light = consumeFixedWindowToken({
    key: `light:${scope}:${clientAddress}`,
    max: config.rateLimitLightMax,
    windowMs: config.rateLimitLightWindowSec * 1000,
  });
  if (!light.allowed) {
    reply.header("Retry-After", String(light.retryAfterSeconds));
    reply.status(429).send({
      error: `Too many requests for ${scope}. Please retry in ${light.retryAfterSeconds}s.`,
      retryAfterSeconds: light.retryAfterSeconds,
    });
    return false;
  }
  return true;
}

function enforceManualFavoritesPublishLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (!config.rateLimitEnabled) {
    return true;
  }
  const clientAddress = getClientAddress(request);
  const manual = consumeFixedWindowToken({
    key: `favorites:manual:${clientAddress}`,
    max: config.rateLimitFavoritesManualMax,
    windowMs: config.rateLimitFavoritesManualWindowSec * 1000,
  });
  if (!manual.allowed) {
    reply.header("Retry-After", String(manual.retryAfterSeconds));
    reply.status(429).send({
      error: `Manual favorite publish limit reached. Please retry in ${manual.retryAfterSeconds}s.`,
      retryAfterSeconds: manual.retryAfterSeconds,
    });
    return false;
  }
  return true;
}

function normalizeCodeForDuplicateCheck(code: string): string {
  return code
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function computeCodeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function enforceFavoriteDuplicateGuard(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
): boolean {
  const normalizedCode = normalizeCodeForDuplicateCheck(code);
  if (!normalizedCode) {
    return true;
  }
  const clientAddress = getClientAddress(request);
  const codeHash = computeCodeHash(normalizedCode);
  const duplicate = consumeFixedWindowToken({
    key: `favorites:duplicate:${clientAddress}:${codeHash}`,
    max: 1,
    windowMs: config.favoritesDuplicateWindowSec * 1000,
  });
  if (!duplicate.allowed) {
    reply.status(409).send({
      error: "Duplicate favorite code detected recently. Please modify code or retry later.",
      retryAfterSeconds: duplicate.retryAfterSeconds,
    });
    return false;
  }
  return true;
}

function tryAcquireSessionSlot(sessionId: string, maxConcurrent = config.sessionConcurrencyMax): boolean {
  const current = sessionInFlightById.get(sessionId) ?? 0;
  if (current >= maxConcurrent) {
    return false;
  }
  sessionInFlightById.set(sessionId, current + 1);
  return true;
}

function releaseSessionSlot(sessionId: string): void {
  const current = sessionInFlightById.get(sessionId);
  if (!current) {
    return;
  }
  if (current <= 1) {
    sessionInFlightById.delete(sessionId);
    return;
  }
  sessionInFlightById.set(sessionId, current - 1);
}

function sendSessionBusy(reply: FastifyReply): FastifyReply {
  return reply.status(409).send({
    error: "Another request is already processing for this session. Please wait and retry.",
  });
}

function sanitizeReadyCheck(
  check: { ok: boolean; provider: string; storage?: { ok: boolean; provider: string } },
) {
  return {
    ok: check.ok,
    provider: check.provider,
    storage: check.storage
      ? {
          ok: check.storage.ok,
          provider: check.storage.provider,
        }
      : undefined,
  };
}

function sendInternalServerError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
): FastifyReply {
  request.log.error({ err: error }, logMessage);
  return reply.status(500).send({
    error: "Internal server error.",
  });
}

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isCorsOriginAllowed(origin));
  },
});

app.addHook("onRequest", async (request) => {
  (request as RequestWithTiming).__startedAtMs = Date.now();
});

app.addHook("onResponse", async (request, reply) => {
  const startedAtMs = (request as RequestWithTiming).__startedAtMs;
  if (!startedAtMs) {
    return;
  }
  const durationMs = Date.now() - startedAtMs;
  if (durationMs < config.slowRequestThresholdMs) {
    return;
  }

  request.log.warn(
    {
      durationMs,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      clientAddress: getClientAddress(request),
    },
    "Slow request detected",
  );
});

app.addHook("onClose", async () => {
  await appStore.close();
  await favoritesStore.close();
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "shader-mvp-api",
    appStoreProvider: appStore.provider,
    favoritesProvider: favoritesStore.provider,
  };
});

app.get("/ready", async (_request, reply) => {
  const appStoreHealth = await appStore.healthCheck();
  const favorites = await favoritesStore.healthCheck();
  const ok = appStoreHealth.ok && favorites.ok;
  return reply.status(ok ? 200 : 503).send({
    ok,
    checks: {
      appStore: sanitizeReadyCheck(appStoreHealth),
      favorites: sanitizeReadyCheck(favorites),
    },
  });
});

app.post("/v1/sessions", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "sessions-create", "light")) {
    return;
  }
  const parsed = createSessionBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.createSession(parsed.data.mode, parsed.data.projectId);
  return reply.send({ session });
});

app.post("/v1/sessions/:id/messages", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "sessions-messages", "generate")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const parsed = messageBody.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id, config.sessionMessageConcurrencyMax)) {
    return sendSessionBusy(reply);
  }

  try {
    if (parsed.data.startNewShader) {
      await appStore.resetIdeation(session.id);
    }

    const latestRevision = await appStore.getLatestRevisionBySession(session.id);
    const storedLatestCode = latestRevision
      ? (await appStore.getArtifactByRevisionAndKind(latestRevision.id, "glsl_fragment"))?.content
      : undefined;
    const latestCode =
      parsed.data.currentCode && parsed.data.currentCode.trim().length > 0
        ? parsed.data.currentCode
        : storedLatestCode;
    const useIteration =
      (Boolean(latestRevision) && !parsed.data.startNewShader) || parsed.data.debugMode;
    const modelOverride =
      parsed.data.debugMode ? config.openaiDebugModel : parsed.data.model?.trim() || undefined;
    const baseUrlOverride =
      parsed.data.debugMode ? config.openaiDebugBaseUrl : parsed.data.baseUrl?.trim() || undefined;
    const channelOverride: LlmChannel | undefined = parsed.data.debugMode
      ? undefined
      : parsed.data.channel;
    const referenceImageDataUrls = parsed.data.referenceImages.map((image) => image.dataUrl);
    if (parsed.data.debugMode && !parsed.data.currentCode?.trim()) {
      return reply.status(400).send({
        error: "debugMode requires currentCode.",
      });
    }
    if (useIteration && !latestCode) {
      return reply.status(409).send({
        error: "Current GLSL context is missing. Please start a new shader and retry.",
      });
    }

    try {
      const pipelineResult = await orchestrator.run({
        session,
        userMessage: parsed.data.content,
        referenceImageDataUrls,
        previewCompileErrors: parsed.data.previewCompileErrors,
        modelOverride,
        baseUrlOverride,
        channelOverride,
        debugMode: parsed.data.debugMode,
        latestRevisionExists: useIteration,
        latestCode,
      });

      const promptText =
        parsed.data.content.trim().length > 0
          ? parsed.data.content
          : `[image-only request, refs=${referenceImageDataUrls.length}]`;

      const revision = await appStore.createRevision({
        sessionId: session.id,
        parentRevisionId: useIteration ? (latestRevision?.id ?? null) : null,
        prompt: promptText,
        llmModel: pipelineResult.llmModel,
        requestedModel: pipelineResult.requestedModel,
        effectiveModel: pipelineResult.effectiveModel,
        fallbackUsed: pipelineResult.fallbackUsed,
        llmLatencyMs: pipelineResult.llmLatencyMs,
        compileStatus: pipelineResult.compileStatus,
        compileErrors: pipelineResult.compileErrors,
      });

      const artifact = await appStore.createArtifact({
        revisionId: revision.id,
        kind: "glsl_fragment",
        content: pipelineResult.code,
        meta: {
          mode: session.mode,
        },
      });

      return reply.send({
        revision,
        artifact: {
          id: artifact.id,
          kind: artifact.kind,
          uri: artifact.uri,
        },
        code: pipelineResult.code,
        startedNewShader: parsed.data.startNewShader,
      });
    } catch (error) {
      if (error instanceof PipelineUnavailableError) {
        return reply.status(501).send({ error: error.message });
      }
      return sendInternalServerError(request, reply, error, "Pipeline execution failed");
    }
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.get("/v1/sessions/:id/ideation/state", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "ideation-state", "light")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const messages = await appStore.listIdeationMessages(session.id);
  const asset = await appStore.getIdeationAsset(session.id);
  const assetPayload = asset
    ? await appStore.getIdeationAssetPayload(session.id)
    : undefined;
  let linkedReferenceImages: string[] = [];
  if (asset && assetPayload) {
    try {
      linkedReferenceImages = await buildLinkedReferenceDataUrls({
        mimeType: asset.mimeType,
        dataBase64: assetPayload.dataBase64,
      });
    } catch (error) {
      request.log.warn({ err: error }, "Failed to build linked references for ideation state");
    }
  }
  return reply.send({
    messages,
    asset: asset
      ? {
          id: asset.id,
          kind: asset.kind,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          bytes: asset.bytes,
          createdAt: asset.createdAt,
        }
      : null,
    linkedReferenceImages,
  });
});

app.post("/v1/sessions/:id/ideation/messages", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "ideation-messages", "heavy")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const parsed = ideationMessageBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id)) {
    return sendSessionBusy(reply);
  }

  try {
    const existingAsset = await appStore.getIdeationAsset(session.id);
    const existingAssetPayload = existingAsset
      ? await appStore.getIdeationAssetPayload(session.id)
      : undefined;
    let assetForInference = existingAsset;
    let assetPayloadForInference = existingAssetPayload;

    if (parsed.data.asset) {
      try {
        const parsedAsset = parseUploadedAsset(parsed.data.asset);
        const parsedAssetBase64 = parsedAsset.bytes.toString("base64");
        if (existingAsset) {
          if (!existingAssetPayload) {
            return reply.status(500).send({
              error: "Ideation asset payload is missing. Please click 新 Shader and retry.",
            });
          }
          const existingBytes = Buffer.from(existingAssetPayload.dataBase64, "base64");
          const sameAsset =
            existingAsset.kind === parsedAsset.kind &&
            existingAsset.mimeType === parsedAsset.mimeType &&
            hashBuffer(existingBytes) === hashBuffer(parsedAsset.bytes);
          if (!sameAsset) {
            return reply.status(409).send({
              error:
                "当前需求提炼会话已绑定一份素材。可继续对话（系统会自动附带该素材）；如需更换，请先点击“新 Shader”重置。",
            });
          }
          assetForInference = existingAsset;
          assetPayloadForInference = existingAssetPayload;
        } else {
          assetForInference = await appStore.setIdeationAsset(session.id, {
            kind: parsedAsset.kind,
            fileName: parsedAsset.safeFileName,
            mimeType: parsedAsset.mimeType,
            bytes: parsedAsset.bytes.length,
            dataBase64: parsedAssetBase64,
          });
          assetPayloadForInference = {
            kind: parsedAsset.kind,
            mimeType: parsedAsset.mimeType,
            dataBase64: parsedAssetBase64,
          };
        }
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Failed to parse uploaded asset.",
        });
      }
    }

    const previousMessages = await appStore.listIdeationMessages(session.id);
    const userText =
      parsed.data.content.trim().length > 0
        ? parsed.data.content.trim()
        : "请分析刚上传的素材并给出可用于 GLSL 生成的专业提示词。";

    try {
      const ideation = await runGeminiIdeation({
        userMessage: userText,
        history: previousMessages.map((item) => ({ role: item.role, text: item.text })),
        asset:
          assetForInference && assetPayloadForInference
            ? {
                mimeType: assetForInference.mimeType,
                dataBase64: assetPayloadForInference.dataBase64,
              }
            : undefined,
      });
      let linkedReferenceImages: string[] = [];
      if (assetForInference && assetPayloadForInference) {
        try {
          linkedReferenceImages = await buildLinkedReferenceDataUrls({
            mimeType: assetForInference.mimeType,
            dataBase64: assetPayloadForInference.dataBase64,
          });
        } catch (error) {
          request.log.warn({ err: error }, "Failed to build linked references for ideation message");
        }
      }

      const userMessage = await appStore.appendIdeationMessage(session.id, {
        role: "user",
        text: userText,
      });
      const assistantMessage = await appStore.appendIdeationMessage(session.id, {
        role: "assistant",
        text: ideation.rawText,
        extractedPrompt: ideation.glslPrompt,
      });

      return reply.send({
        userMessage,
        assistantMessage,
        asset: assetForInference
          ? {
              id: assetForInference.id,
              kind: assetForInference.kind,
              fileName: assetForInference.fileName,
              mimeType: assetForInference.mimeType,
              bytes: assetForInference.bytes,
              createdAt: assetForInference.createdAt,
            }
          : null,
        model: {
          requested: ideation.requestedModel,
          effective: ideation.effectiveModel,
          fallbackUsed: ideation.fallbackUsed,
          latencyMs: ideation.latencyMs,
        },
        linkedReferenceImages,
        extractedPrompt: ideation.glslPrompt,
        analysis: ideation.analysis,
      });
    } catch (error) {
      return sendInternalServerError(request, reply, error, "Ideation message failed");
    }
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.post("/v1/sessions/:id/ideation/reset", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "ideation-reset", "heavy")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id)) {
    return sendSessionBusy(reply);
  }

  try {
    await appStore.resetIdeation(session.id);
    return reply.send({ ok: true });
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.post("/v1/sessions/:id/optimize/suggest", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "optimize-suggest", "heavy")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeSuggestBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id)) {
    return sendSessionBusy(reply);
  }

  try {
    const ideationAsset = await appStore.getIdeationAsset(session.id);
    const ideationAssetPayload = ideationAsset
      ? await appStore.getIdeationAssetPayload(session.id)
      : undefined;

    try {
      const optimize = await runGeminiOptimize({
        targetPrompt: parsed.data.targetPrompt,
        currentCode: parsed.data.currentCode,
        previewFrameDataUrl: parsed.data.previewFrameDataUrl,
        userInstruction: parsed.data.userInstruction,
        ideationAsset: ideationAsset && ideationAssetPayload
          ? {
              mimeType: ideationAsset.mimeType,
              dataBase64: ideationAssetPayload.dataBase64,
            }
          : undefined,
      });

      return reply.send({
        optimize: {
          analysis: optimize.analysis,
          prompt: optimize.optimizePrompt,
          model: {
            requested: optimize.requestedModel,
            effective: optimize.effectiveModel,
            fallbackUsed: optimize.fallbackUsed,
            latencyMs: optimize.latencyMs,
          },
          assetUsed: Boolean(ideationAsset && ideationAssetPayload),
        },
      });
    } catch (error) {
      return sendInternalServerError(request, reply, error, "Optimize suggestion failed");
    }
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.post("/v1/sessions/:id/optimize/apply", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "optimize-apply", "heavy")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeApplyBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id)) {
    return sendSessionBusy(reply);
  }

  try {
    const parentRevision = await resolveParentRevision(session.id, parsed.data.parentRevisionId);
    if (parsed.data.parentRevisionId && !parentRevision) {
      return reply.status(404).send({ error: "Parent revision not found." });
    }
    if (parentRevision && parentRevision.sessionId !== session.id) {
      return reply.status(409).send({ error: "Parent revision does not belong to this session." });
    }

    try {
      const optimizeUserMessage = [
        "请基于以下优化建议修改当前 GLSL，优先修正核心差异并尽量保留已有成功部分。",
        parsed.data.optimizePrompt,
      ]
        .filter(Boolean)
        .join("\n\n");

      const pipelineResult = await orchestrator.run({
        session,
        userMessage: optimizeUserMessage,
        referenceImageDataUrls: [],
        modelOverride: parsed.data.model?.trim() || undefined,
        baseUrlOverride: parsed.data.baseUrl?.trim() || undefined,
        channelOverride: parsed.data.channel,
        debugMode: false,
        latestRevisionExists: true,
        latestCode: parsed.data.currentCode,
      });

      const revision = await appStore.createRevision({
        sessionId: session.id,
        parentRevisionId: parentRevision?.id ?? null,
        prompt: `[one-click optimize apply]\n${parsed.data.optimizePrompt}`,
        llmModel: pipelineResult.llmModel,
        requestedModel: pipelineResult.requestedModel,
        effectiveModel: pipelineResult.effectiveModel,
        fallbackUsed: pipelineResult.fallbackUsed,
        llmLatencyMs: pipelineResult.llmLatencyMs,
        compileStatus: pipelineResult.compileStatus,
        compileErrors: pipelineResult.compileErrors,
      });

      await appStore.createArtifact({
        revisionId: revision.id,
        kind: "glsl_fragment",
        content: pipelineResult.code,
        meta: {
          mode: session.mode,
        },
      });

      return reply.send({
        revision,
        code: pipelineResult.code,
      });
    } catch (error) {
      if (error instanceof PipelineUnavailableError) {
        return reply.status(501).send({ error: error.message });
      }
      return sendInternalServerError(request, reply, error, "Optimize apply failed");
    }
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.post("/v1/sessions/:id/optimize-current", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "optimize-current", "heavy")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (!tryAcquireSessionSlot(session.id)) {
    return sendSessionBusy(reply);
  }

  try {
    const parentRevision =
      parsed.data.parentRevisionId && parsed.data.parentRevisionId.trim().length > 0
        ? await appStore.getRevision(parsed.data.parentRevisionId.trim())
        : await appStore.getLatestRevisionBySession(session.id);
    if (parsed.data.parentRevisionId && !parentRevision) {
      return reply.status(404).send({ error: "Parent revision not found." });
    }
    if (parentRevision && parentRevision.sessionId !== session.id) {
      return reply.status(409).send({ error: "Parent revision does not belong to this session." });
    }

    const ideationAsset = await appStore.getIdeationAsset(session.id);
    const ideationAssetPayload = ideationAsset
      ? await appStore.getIdeationAssetPayload(session.id)
      : undefined;

    try {
      const optimize = await runGeminiOptimize({
        targetPrompt: parsed.data.targetPrompt,
        currentCode: parsed.data.currentCode,
        previewFrameDataUrl: parsed.data.previewFrameDataUrl,
        userInstruction: parsed.data.userInstruction,
        ideationAsset: ideationAsset && ideationAssetPayload
          ? {
              mimeType: ideationAsset.mimeType,
              dataBase64: ideationAssetPayload.dataBase64,
            }
          : undefined,
      });

      const optimizeUserMessage = [
        "请基于以下优化建议修改当前 GLSL，优先修正核心差异并尽量保留已有成功部分。",
        optimize.optimizePrompt,
      ]
        .filter(Boolean)
        .join("\n\n");

      const pipelineResult = await orchestrator.run({
        session,
        userMessage: optimizeUserMessage,
        referenceImageDataUrls: [parsed.data.previewFrameDataUrl],
        modelOverride: parsed.data.model?.trim() || undefined,
        baseUrlOverride: parsed.data.baseUrl?.trim() || undefined,
        channelOverride: parsed.data.channel,
        debugMode: false,
        latestRevisionExists: true,
        latestCode: parsed.data.currentCode,
      });

      const revision = await appStore.createRevision({
        sessionId: session.id,
        parentRevisionId: parentRevision?.id ?? null,
        prompt: `[one-click optimize]\n${optimize.optimizePrompt}`,
        llmModel: pipelineResult.llmModel,
        requestedModel: pipelineResult.requestedModel,
        effectiveModel: pipelineResult.effectiveModel,
        fallbackUsed: pipelineResult.fallbackUsed,
        llmLatencyMs: pipelineResult.llmLatencyMs,
        compileStatus: pipelineResult.compileStatus,
        compileErrors: pipelineResult.compileErrors,
      });

      await appStore.createArtifact({
        revisionId: revision.id,
        kind: "glsl_fragment",
        content: pipelineResult.code,
        meta: {
          mode: session.mode,
        },
      });

      return reply.send({
        revision,
        code: pipelineResult.code,
        optimize: {
          analysis: optimize.analysis,
          prompt: optimize.optimizePrompt,
          model: {
            requested: optimize.requestedModel,
            effective: optimize.effectiveModel,
            fallbackUsed: optimize.fallbackUsed,
            latencyMs: optimize.latencyMs,
          },
          assetUsed: Boolean(ideationAsset && ideationAssetPayload),
        },
      });
    } catch (error) {
      if (error instanceof PipelineUnavailableError) {
        return reply.status(501).send({ error: error.message });
      }
      return sendInternalServerError(request, reply, error, "Optimize current shader failed");
    }
  } finally {
    releaseSessionSlot(session.id);
  }
});

app.get("/v1/favorites", async (_request, reply) => {
  if (!enforceRateLimit(_request, reply, "favorites-list", "light")) {
    return;
  }
  const favorites = await favoritesStore.listFavorites();
  return reply.send({ favorites });
});

app.get("/v1/favorites/:id", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "favorites-detail", "light")) {
    return;
  }
  const favoriteId = (request.params as { id: string }).id;
  const favorite = await favoritesStore.getFavoriteById(favoriteId);
  if (!favorite) {
    return reply.status(404).send({ error: "Favorite not found." });
  }
  return reply.send({ favorite });
});

app.post("/v1/favorites", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "favorites-create", "heavy")) {
    return;
  }
  const parsed = favoriteCreateBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const requestedSessionId = parsed.data.sessionId?.trim();
  const requestedRevisionId = parsed.data.revisionId?.trim();
  let validatedSessionId: string | undefined;
  let validatedRevisionId: string | undefined;
  if (requestedSessionId && requestedRevisionId) {
    const [session, revision] = await Promise.all([
      appStore.getSession(requestedSessionId),
      appStore.getRevision(requestedRevisionId),
    ]);
    if (session && revision && revision.sessionId === session.id) {
      validatedSessionId = session.id;
      validatedRevisionId = revision.id;
    }
  }
  const isManualFavoritePublish = !(validatedSessionId && validatedRevisionId);
  if (!enforceFavoriteDuplicateGuard(request, reply, parsed.data.code)) {
    return;
  }
  if (isManualFavoritePublish && !enforceManualFavoritesPublishLimit(request, reply)) {
    return;
  }

  const manualName = parsed.data.name?.trim();
  const manualPromptPreview = parsed.data.promptPreview?.trim();
  const useManualNaming = Boolean(manualName);

  let naming: { name: string; promptPreview: string } = {
    name: manualName || "未命名Shader",
    promptPreview: manualPromptPreview || parsed.data.sourcePrompt.slice(0, 280),
  };
  if (!useManualNaming) {
    try {
      naming = await nameFavoriteFromGemini({
        sourcePrompt: parsed.data.sourcePrompt,
        code: parsed.data.code,
      });
    } catch (error) {
      request.log.warn({ err: error }, "Favorite namer failed, fallback to local naming");
    }
  }

  try {
    const favorite = await favoritesStore.createFavorite({
      suggestedName: naming.name,
      sourcePrompt: parsed.data.sourcePrompt,
      promptPreview: manualPromptPreview || naming.promptPreview,
      code: parsed.data.code,
      coverImageDataUrl: parsed.data.coverImageDataUrl,
      revisionId: validatedRevisionId,
      sessionId: validatedSessionId,
    });

    return reply.send({
      favorite,
      namer: {
        requestedModel: useManualNaming ? "manual" : config.favoriteNamerModel,
        fallbackModel: config.favoriteNamerFallbackModel ?? null,
        manual: useManualNaming,
      },
    });
  } catch (error) {
    return sendInternalServerError(request, reply, error, "Create favorite failed");
  }
});

app.post("/v1/favorites/:id/rename", async (request, reply) => {
  request.log.info("Favorite rename is disabled for public gallery.");
  return reply.status(410).send({
    error: "Favorite rename is disabled in public gallery mode.",
  });
});

app.post("/v1/favorites/:id/archive", async (request, reply) => {
  request.log.info("Favorite archive is disabled for public gallery.");
  return reply.status(410).send({
    error: "Favorite delete/archive is disabled in public gallery mode.",
  });
});

app.get("/v1/sessions/:id/revisions/latest", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "revisions-latest", "light")) {
    return;
  }
  const sessionId = (request.params as { id: string }).id;
  const session = await appStore.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const revision = await appStore.getLatestRevisionBySession(session.id);
  if (!revision) {
    return reply.status(404).send({ error: "No revisions yet." });
  }

  const artifact = await appStore.getArtifactByRevisionAndKind(revision.id, "glsl_fragment");
  if (!artifact) {
    return reply.status(404).send({ error: "No GLSL artifact for latest revision." });
  }

  return reply.send({ revision, code: artifact.content });
});

app.post("/v1/revisions/:id/export", async (request, reply) => {
  if (!enforceRateLimit(request, reply, "revisions-export", "light")) {
    return;
  }
  const revisionId = (request.params as { id: string }).id;
  const parsed = exportBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const revision = await appStore.getRevision(revisionId);
  if (!revision) {
    return reply.status(404).send({ error: "Revision not found." });
  }

  if (parsed.data.format !== "glsl") {
    return reply.status(400).send({ error: "Unsupported export format." });
  }

  const artifact = await appStore.getArtifactByRevisionAndKind(revision.id, "glsl_fragment");
  if (!artifact) {
    return reply.status(404).send({ error: "GLSL artifact not found." });
  }

  const session = await appStore.getSession(revision.sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found for revision." });
  }

  try {
    const exported = await orchestrator
      .getPipeline(session.mode)
      .export({ revision, code: artifact.content });
    return reply.send(exported);
  } catch (error) {
    if (error instanceof PipelineUnavailableError) {
      return reply.status(501).send({ error: error.message });
    }
    return sendInternalServerError(request, reply, error, "Pipeline export failed");
  }
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "Unhandled request error");
  reply.status(500).send({ error: "Internal server error." });
});

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

app.log.info(`API listening on http://localhost:${config.port}`);
app.log.info(`Default mode support: ${(["shader_glsl", "pbr_texture"] as Mode[]).join(", ")}`);
