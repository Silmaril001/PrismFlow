import cors from "@fastify/cors";
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
import { InMemoryStore } from "./store.js";

const app = Fastify({
  logger: true,
  bodyLimit: 64 * 1024 * 1024,
});
const store = new InMemoryStore();
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

const favoriteRenameBody = z.object({
  name: z.string().min(1).max(80),
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

function resolveParentRevision(
  sessionId: string,
  parentRevisionId?: string,
) {
  const parentRevision =
    parentRevisionId && parentRevisionId.trim().length > 0
      ? store.getRevision(parentRevisionId.trim())
      : store.getLatestRevisionBySession(sessionId);
  return parentRevision;
}

await app.register(cors, {
  origin: true,
});

app.addHook("onClose", async () => {
  await favoritesStore.close();
});

app.get("/health", async () => {
  return { ok: true, service: "shader-mvp-api", favoritesProvider: favoritesStore.provider };
});

app.get("/ready", async (_request, reply) => {
  const favorites = await favoritesStore.healthCheck();
  const ok = favorites.ok;
  return reply.status(ok ? 200 : 503).send({
    ok,
    checks: {
      favorites,
    },
  });
});

app.post("/v1/sessions", async (request, reply) => {
  const parsed = createSessionBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.createSession(parsed.data.mode, parsed.data.projectId);
  return reply.send({ session });
});

app.post("/v1/sessions/:id/messages", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const parsed = messageBody.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  if (parsed.data.startNewShader) {
    const { asset } = store.resetIdeation(session.id);
    if (asset?.storagePath) {
      try {
        unlinkSync(asset.storagePath);
        const sessionDir = join(config.ideationAssetDir, session.id);
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  const latestRevision = store.getLatestRevisionBySession(session.id);
  const storedLatestCode = latestRevision
    ? store.getArtifactByRevisionAndKind(latestRevision.id, "glsl_fragment")?.content
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

    const revision = store.createRevision({
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

    const artifact = store.createArtifact({
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

    request.log.error({ err: error }, "Pipeline execution failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unknown internal error",
    });
  }
});

app.get("/v1/sessions/:id/ideation/state", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const messages = store.listIdeationMessages(session.id);
  const asset = store.getIdeationAsset(session.id);
  let linkedReferenceImages: string[] = [];
  if (asset) {
    try {
      linkedReferenceImages = await buildLinkedReferenceDataUrls({
        mimeType: asset.mimeType,
        storagePath: asset.storagePath,
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
  const sessionId = (request.params as { id: string }).id;
  const parsed = ideationMessageBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const existingAsset = store.getIdeationAsset(session.id);
  let assetForInference = existingAsset;

  if (parsed.data.asset) {
    try {
      const parsedAsset = parseUploadedAsset(parsed.data.asset);
      if (existingAsset) {
        const existingBytes = readFileSync(existingAsset.storagePath);
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
      } else {
        const sessionDir = join(config.ideationAssetDir, session.id);
        mkdirSync(sessionDir, { recursive: true });
        const storagePath = join(
          sessionDir,
          `${Date.now()}-${randomUUID().slice(0, 8)}${parsedAsset.extension}`,
        );
        writeFileSync(storagePath, parsedAsset.bytes);
        assetForInference = store.setIdeationAsset(session.id, {
          kind: parsedAsset.kind,
          fileName: parsedAsset.safeFileName,
          mimeType: parsedAsset.mimeType,
          bytes: parsedAsset.bytes.length,
          storagePath,
        });
      }
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Failed to parse uploaded asset.",
      });
    }
  }

  const previousMessages = store.listIdeationMessages(session.id);
  const userText = parsed.data.content.trim().length > 0 ? parsed.data.content.trim() : "请分析刚上传的素材并给出可用于 GLSL 生成的专业提示词。";

  try {
    const ideation = await runGeminiIdeation({
      userMessage: userText,
      history: previousMessages.map((item) => ({ role: item.role, text: item.text })),
      asset: assetForInference
        ? {
            mimeType: assetForInference.mimeType,
            storagePath: assetForInference.storagePath,
          }
        : undefined,
    });
    let linkedReferenceImages: string[] = [];
    if (assetForInference) {
      try {
        linkedReferenceImages = await buildLinkedReferenceDataUrls({
          mimeType: assetForInference.mimeType,
          storagePath: assetForInference.storagePath,
        });
      } catch (error) {
        request.log.warn({ err: error }, "Failed to build linked references for ideation message");
      }
    }

    const userMessage = store.appendIdeationMessage(session.id, {
      role: "user",
      text: userText,
    });
    const assistantMessage = store.appendIdeationMessage(session.id, {
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
    request.log.error({ err: error }, "Ideation message failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Ideation flow failed.",
    });
  }
});

app.post("/v1/sessions/:id/ideation/reset", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const { asset } = store.resetIdeation(session.id);
  if (asset?.storagePath) {
    try {
      unlinkSync(asset.storagePath);
      const sessionDir = join(config.ideationAssetDir, session.id);
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  return reply.send({ ok: true });
});

app.post("/v1/sessions/:id/optimize/suggest", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeSuggestBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const ideationAsset = store.getIdeationAsset(session.id);

  try {
    const optimize = await runGeminiOptimize({
      targetPrompt: parsed.data.targetPrompt,
      currentCode: parsed.data.currentCode,
      previewFrameDataUrl: parsed.data.previewFrameDataUrl,
      userInstruction: parsed.data.userInstruction,
      ideationAsset: ideationAsset
        ? {
            mimeType: ideationAsset.mimeType,
            storagePath: ideationAsset.storagePath,
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
        assetUsed: Boolean(ideationAsset),
      },
    });
  } catch (error) {
    request.log.error({ err: error }, "Optimize suggestion failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unknown internal error",
    });
  }
});

app.post("/v1/sessions/:id/optimize/apply", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeApplyBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const parentRevision = resolveParentRevision(session.id, parsed.data.parentRevisionId);
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

    const revision = store.createRevision({
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

    store.createArtifact({
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

    request.log.error({ err: error }, "Optimize apply failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unknown internal error",
    });
  }
});

app.post("/v1/sessions/:id/optimize-current", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const parsed = optimizeBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const parentRevision =
    parsed.data.parentRevisionId && parsed.data.parentRevisionId.trim().length > 0
      ? store.getRevision(parsed.data.parentRevisionId.trim())
      : store.getLatestRevisionBySession(session.id);
  if (parsed.data.parentRevisionId && !parentRevision) {
    return reply.status(404).send({ error: "Parent revision not found." });
  }
  if (parentRevision && parentRevision.sessionId !== session.id) {
    return reply.status(409).send({ error: "Parent revision does not belong to this session." });
  }

  const ideationAsset = store.getIdeationAsset(session.id);

  try {
    const optimize = await runGeminiOptimize({
      targetPrompt: parsed.data.targetPrompt,
      currentCode: parsed.data.currentCode,
      previewFrameDataUrl: parsed.data.previewFrameDataUrl,
      userInstruction: parsed.data.userInstruction,
      ideationAsset: ideationAsset
        ? {
            mimeType: ideationAsset.mimeType,
            storagePath: ideationAsset.storagePath,
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

    const revision = store.createRevision({
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

    store.createArtifact({
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
        assetUsed: Boolean(ideationAsset),
      },
    });
  } catch (error) {
    if (error instanceof PipelineUnavailableError) {
      return reply.status(501).send({ error: error.message });
    }

    request.log.error({ err: error }, "Optimize current shader failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unknown internal error",
    });
  }
});

app.get("/v1/favorites", async (_request, reply) => {
  const favorites = await favoritesStore.listFavorites();
  return reply.send({ favorites });
});

app.get("/v1/favorites/:id", async (request, reply) => {
  const favoriteId = (request.params as { id: string }).id;
  const favorite = await favoritesStore.getFavoriteById(favoriteId);
  if (!favorite) {
    return reply.status(404).send({ error: "Favorite not found." });
  }
  return reply.send({ favorite });
});

app.post("/v1/favorites", async (request, reply) => {
  const parsed = favoriteCreateBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
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
      revisionId: parsed.data.revisionId,
      sessionId: parsed.data.sessionId,
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
    request.log.error({ err: error }, "Create favorite failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Create favorite failed.",
    });
  }
});

app.post("/v1/favorites/:id/rename", async (request, reply) => {
  const favoriteId = (request.params as { id: string }).id;
  const parsed = favoriteRenameBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  try {
    const favorite = await favoritesStore.renameFavoriteById(favoriteId, parsed.data.name);
    if (!favorite) {
      return reply.status(404).send({ error: "Favorite not found." });
    }
    return reply.send({ favorite });
  } catch (error) {
    request.log.error({ err: error }, "Rename favorite failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Rename favorite failed.",
    });
  }
});

app.post("/v1/favorites/:id/archive", async (request, reply) => {
  const favoriteId = (request.params as { id: string }).id;
  try {
    const archived = await favoritesStore.archiveFavoriteById(favoriteId);
    if (!archived) {
      return reply.status(404).send({ error: "Favorite not found." });
    }
    return reply.send({ ok: true, favoriteId: archived.id, archivedAt: archived.archivedAt });
  } catch (error) {
    request.log.error({ err: error }, "Archive favorite failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Archive favorite failed.",
    });
  }
});

app.get("/v1/sessions/:id/revisions/latest", async (request, reply) => {
  const sessionId = (request.params as { id: string }).id;
  const session = store.getSession(sessionId);
  if (!session) {
    return reply.status(404).send({ error: "Session not found." });
  }

  const revision = store.getLatestRevisionBySession(session.id);
  if (!revision) {
    return reply.status(404).send({ error: "No revisions yet." });
  }

  const artifact = store.getArtifactByRevisionAndKind(revision.id, "glsl_fragment");
  if (!artifact) {
    return reply.status(404).send({ error: "No GLSL artifact for latest revision." });
  }

  return reply.send({ revision, code: artifact.content });
});

app.post("/v1/revisions/:id/export", async (request, reply) => {
  const revisionId = (request.params as { id: string }).id;
  const parsed = exportBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const revision = store.getRevision(revisionId);
  if (!revision) {
    return reply.status(404).send({ error: "Revision not found." });
  }

  if (parsed.data.format !== "glsl") {
    return reply.status(400).send({ error: "Unsupported export format." });
  }

  const artifact = store.getArtifactByRevisionAndKind(revision.id, "glsl_fragment");
  if (!artifact) {
    return reply.status(404).send({ error: "GLSL artifact not found." });
  }

  const session = store.getSession(revision.sessionId);
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

    request.log.error({ err: error }, "Pipeline export failed");
    return reply.status(500).send({
      error: error instanceof Error ? error.message : "Unknown internal error",
    });
  }
});

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : "Unknown internal error";
  reply.status(500).send({ error: message });
});

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

app.log.info(`API listening on http://localhost:${config.port}`);
app.log.info(`Default mode support: ${(["shader_glsl", "pbr_texture"] as Mode[]).join(", ")}`);
