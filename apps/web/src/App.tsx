import {
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyOptimizePrompt,
  createFavorite,
  createSession,
  exportRevision,
  getIdeationState,
  requestOptimizeSuggestion,
  resetIdeation,
  sendIdeationMessage,
  sendMessage,
  type IdeationAssetMeta,
  type IdeationMessage,
  type ReferenceImageInput,
  type Revision,
  type Session,
} from "./api";
import {
  ShaderPreview,
  captureShaderStillFrameDataUrl,
  type ShaderPreviewHandle,
} from "./components/ShaderPreview";

interface ChatItem {
  role: "user" | "assistant";
  text: string;
}

interface ReferenceImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  source: "chat" | "ideation";
}

interface GenerationRequestSnapshot {
  content: string;
  startNewShader: boolean;
  currentCode?: string;
  referenceImages: ReferenceImageInput[];
  debugMode?: boolean;
}

interface GenerationBatchSnapshot extends GenerationRequestSnapshot {
  parallelCount: number;
}

interface OptimizeHistoryEntry {
  code: string;
  revision: Revision | null;
}

interface ShaderResultSlot {
  slotKey: string;
  index: number;
  status: "pending" | "success" | "error";
  code: string;
  syncedCode: string;
  revision: Revision | null;
  optimizeHistory: OptimizeHistoryEntry[];
  optimizeCursor: number;
  errorMessage?: string;
}

interface PendingIdeationAsset {
  fileName: string;
  mimeType: string;
  dataUrl: string;
  bytes: number;
  kind: "image" | "video";
}

interface IdeationModelMeta {
  requested: string;
  effective: string;
  fallbackUsed: boolean;
  latencyMs: number;
}

interface SlotFavoriteMeta {
  id: string;
  name: string;
}

const INITIAL_PROMPT = "Create a full-screen shader with flowing blue energy and a calm rhythm.";
const DEFAULT_PREVIEW_WIDTH = 960;
const DEFAULT_PREVIEW_HEIGHT = 540;
const MIN_PARALLEL_COUNT = 1;
const MAX_PARALLEL_COUNT = 10;
const DEFAULT_PARALLEL_COUNT = 5;
const DEFAULT_USER_MODEL = "gpt-5.5";
const SHADER_MODE_TITLE = "Procedural Shader Mode (GLSL)";
const SHADER_MODE_HINT = "Best for mathematically driven visuals like glow effects, dissolve, fluid motion, and holographic scans.";
const MAX_REFERENCE_IMAGES = 5;
const MAX_REFERENCE_IMAGE_BYTES = 1_500_000;
const MAX_REFERENCE_IMAGE_DIMENSION = 1536;
const MAX_IDEATION_ASSET_BYTES = 25 * 1024 * 1024;

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return 0;
  }
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = dataUrl;
  });
}

async function prepareReferenceImage(file: File): Promise<ReferenceImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only image paste is supported.");
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const sourceImage = await loadImageElement(sourceDataUrl);

  const maxSide = Math.max(sourceImage.width, sourceImage.height);
  const scale =
    maxSide > MAX_REFERENCE_IMAGE_DIMENSION ? MAX_REFERENCE_IMAGE_DIMENSION / maxSide : 1;
  const targetWidth = Math.max(1, Math.round(sourceImage.width * scale));
  const targetHeight = Math.max(1, Math.round(sourceImage.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Browser does not support image preprocessing.");
  }
  ctx.drawImage(sourceImage, 0, 0, targetWidth, targetHeight);

  let mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  let dataUrl = canvas.toDataURL(mimeType, 0.88);
  let bytes = estimateDataUrlBytes(dataUrl);

  if (bytes > MAX_REFERENCE_IMAGE_BYTES && mimeType === "image/png") {
    mimeType = "image/jpeg";
    dataUrl = canvas.toDataURL(mimeType, 0.88);
    bytes = estimateDataUrlBytes(dataUrl);
  }

  if (bytes > MAX_REFERENCE_IMAGE_BYTES && mimeType === "image/jpeg") {
    for (let quality = 0.8; quality >= 0.5; quality -= 0.1) {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
      bytes = estimateDataUrlBytes(dataUrl);
      if (bytes <= MAX_REFERENCE_IMAGE_BYTES) {
        break;
      }
    }
  }

  if (bytes > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("Image is too large. Please paste a smaller image (recommended <= 1.5MB each).");
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dataUrl,
    mimeType,
    bytes,
    width: targetWidth,
    height: targetHeight,
    source: "chat",
  };
}

function mimeTypeFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+);base64,/i);
  return match?.[1] ?? "image/png";
}

async function prepareLinkedReferenceImage(dataUrl: string): Promise<ReferenceImage> {
  const image = await loadImageElement(dataUrl);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dataUrl,
    mimeType: mimeTypeFromDataUrl(dataUrl),
    bytes: estimateDataUrlBytes(dataUrl),
    width: image.width,
    height: image.height,
    source: "ideation",
  };
}

async function prepareIdeationAsset(file: File): Promise<PendingIdeationAsset> {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  if (!isImage && !isVideo) {
    throw new Error("Only image or video uploads are supported.");
  }
  if (file.size > MAX_IDEATION_ASSET_BYTES) {
    throw new Error("Asset is too large. Please keep it under 25MB.");
  }
  const dataUrl = await readFileAsDataUrl(file);
  const bytes = estimateDataUrlBytes(dataUrl);
  if (bytes > MAX_IDEATION_ASSET_BYTES) {
    throw new Error("Encoded asset exceeds 25MB. Please use a smaller file.");
  }
  return {
    fileName: file.name,
    mimeType: file.type || (isImage ? "image/png" : "video/webm"),
    dataUrl,
    bytes,
    kind: isVideo ? "video" : "image",
  };
}

export function App() {
  const previewRef = useRef<ShaderPreviewHandle | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState(INITIAL_PROMPT);
  const [parallelCount, setParallelCount] = useState(DEFAULT_PARALLEL_COUNT);
  const [resultSlots, setResultSlots] = useState<ShaderResultSlot[]>([]);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [draftShaderCode, setDraftShaderCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewCompileError, setPreviewCompileError] = useState("");
  const [startNewShaderOnNextSend, setStartNewShaderOnNextSend] = useState(false);
  const [showNewShaderConfirm, setShowNewShaderConfirm] = useState(false);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [lastGenerationRequest, setLastGenerationRequest] =
    useState<GenerationBatchSnapshot | null>(null);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [showOptimizeInputDialog, setShowOptimizeInputDialog] = useState(false);
  const [optimizeUserInstructionInput, setOptimizeUserInstructionInput] = useState("");
  const [ideationDialogOpen, setIdeationDialogOpen] = useState(false);
  const [ideationInput, setIdeationInput] = useState("");
  const [ideationMessages, setIdeationMessages] = useState<IdeationMessage[]>([]);
  const [ideationAsset, setIdeationAsset] = useState<IdeationAssetMeta | null>(null);
  const [pendingIdeationAsset, setPendingIdeationAsset] = useState<PendingIdeationAsset | null>(null);
  const [ideationLoading, setIdeationLoading] = useState(false);
  const [ideationModelMeta, setIdeationModelMeta] = useState<IdeationModelMeta | null>(null);
  const [favoriteBySlotKey, setFavoriteBySlotKey] = useState<Record<string, SlotFavoriteMeta>>({});
  const [favoriteLoadingBySlotKey, setFavoriteLoadingBySlotKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setError("");
      setLoading(true);
      setResultSlots([]);
      setSelectedResultIndex(0);
      setDraftShaderCode("");
      setChat([]);
      setPreviewCompileError("");
      setStartNewShaderOnNextSend(false);
      setShowNewShaderConfirm(false);
      setShowRegenerateConfirm(false);
      setShowOptimizeInputDialog(false);
      setOptimizeUserInstructionInput("");
      setReferenceImages([]);
      setLastGenerationRequest(null);
      setParallelCount(DEFAULT_PARALLEL_COUNT);
      setIdeationDialogOpen(false);
      setIdeationInput("");
      setIdeationMessages([]);
      setIdeationAsset(null);
      setPendingIdeationAsset(null);
      setIdeationLoading(false);
      setIdeationModelMeta(null);
      setFavoriteBySlotKey({});
      setFavoriteLoadingBySlotKey({});

      try {
        const created = await createSession("shader_glsl");
        if (!cancelled) {
          setSession(created);
          try {
            const ideationState = await getIdeationState(created.id);
            if (!cancelled) {
              setIdeationMessages(ideationState.messages);
              setIdeationAsset(ideationState.asset);
              if (ideationState.linkedReferenceImages.length > 0) {
                try {
                  await syncIdeationLinkedReferences(ideationState.linkedReferenceImages);
                } catch {
                  // Keep chat attachments as-is when hydration fails.
                }
              }
            }
          } catch {
            // Keep local defaults if ideation state API is unavailable.
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to create session.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);
  const selectedSlot = resultSlots[selectedResultIndex] ?? null;
  const shaderCode = selectedSlot ? selectedSlot.code : draftShaderCode;
  const latestRevision = selectedSlot?.revision ?? null;
  const canUndoOptimize =
    Boolean(selectedSlot) &&
    (selectedSlot?.optimizeHistory.length ?? 0) > 1 &&
    (selectedSlot?.optimizeCursor ?? 0) > 0;
  const canRedoOptimize =
    Boolean(selectedSlot) &&
    (selectedSlot?.optimizeHistory.length ?? 0) > 1 &&
    (selectedSlot?.optimizeCursor ?? 0) < (selectedSlot?.optimizeHistory.length ?? 1) - 1;
  const hasLocalCodeEdits = selectedSlot
    ? Boolean(selectedSlot.syncedCode) && selectedSlot.code !== selectedSlot.syncedCode
    : false;
  const selectedSlotFavorite = selectedSlot ? favoriteBySlotKey[selectedSlot.slotKey] : undefined;
  const canSend = Boolean(session) && !loading && (input.trim().length > 0 || referenceImages.length > 0);
  const ideationAssetLocked = Boolean(ideationAsset) || Boolean(pendingIdeationAsset);
  const latestIdeationPrompt = useMemo(() => {
    for (let index = ideationMessages.length - 1; index >= 0; index -= 1) {
      const item = ideationMessages[index];
      if (!item || item.role !== "assistant") {
        continue;
      }
      const candidate = item.extractedPrompt?.trim() || item.text.trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
    return "";
  }, [ideationMessages]);

  function handleOpenFavoritesPage() {
    window.open("/favorites", "_blank", "noopener,noreferrer");
  }

  function handleOpenLogsPage() {
    window.open("/logs", "_blank", "noopener,noreferrer");
  }

  async function syncIdeationLinkedReferences(dataUrls: string[]) {
    const limited = dataUrls.slice(0, MAX_REFERENCE_IMAGES);
    const prepared = await Promise.all(limited.map((dataUrl) => prepareLinkedReferenceImage(dataUrl)));
    setReferenceImages((prev) => {
      const manual = prev.filter((image) => image.source !== "ideation");
      const slotsForManual = Math.max(0, MAX_REFERENCE_IMAGES - prepared.length);
      return [...manual.slice(0, slotsForManual), ...prepared];
    });
    if (dataUrls.length > limited.length) {
      setError(`At most ${MAX_REFERENCE_IMAGES} linked reference images can be shown. Extra images were truncated.`);
    }
  }

  async function resetIdeationMemory(silent = false) {
    if (!session) {
      setIdeationMessages([]);
      setIdeationAsset(null);
      setPendingIdeationAsset(null);
      setIdeationInput("");
      setIdeationModelMeta(null);
      setReferenceImages((prev) => prev.filter((image) => image.source !== "ideation"));
      return;
    }
    try {
      await resetIdeation(session.id);
      setIdeationMessages([]);
      setIdeationAsset(null);
      setPendingIdeationAsset(null);
      setIdeationInput("");
      setIdeationModelMeta(null);
      setReferenceImages((prev) => prev.filter((image) => image.source !== "ideation"));
      if (!silent) {
        setChat((prev) => [
          ...prev,
          {
            role: "assistant",
            text: "Ideation chat history and uploaded asset have been reset.",
          },
        ]);
      }
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "Failed to reset ideation session.");
      }
    }
  }

  function handleOpenIdeationDialog() {
    if (loading || !session) {
      return;
    }
    setIdeationDialogOpen(true);
  }

  function handleCloseIdeationDialog() {
    setIdeationDialogOpen(false);
  }

  async function handlePickIdeationAsset(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) {
      return;
    }
    if (ideationAssetLocked) {
      setError(
        "This ideation session already has a bound asset. You can keep chatting and the asset will be attached automatically; click \"New Shader\" to replace it.",
      );
      return;
    }

    try {
      const prepared = await prepareIdeationAsset(picked);
      setPendingIdeationAsset(prepared);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Asset processing failed.");
    }
  }

  function handleClearPendingIdeationAsset() {
    setPendingIdeationAsset(null);
  }

  async function handleSendIdeationMessage(event: FormEvent) {
    event.preventDefault();
    if (!session || ideationLoading) {
      return;
    }
    if (ideationInput.trim().length === 0 && !pendingIdeationAsset) {
      return;
    }

    setIdeationLoading(true);
    setError("");
    try {
      const result = await sendIdeationMessage(session.id, {
        content: ideationInput.trim(),
        asset: pendingIdeationAsset
          ? {
              fileName: pendingIdeationAsset.fileName,
              mimeType: pendingIdeationAsset.mimeType,
              dataUrl: pendingIdeationAsset.dataUrl,
            }
          : undefined,
      });
      setIdeationMessages((prev) => [...prev, result.userMessage, result.assistantMessage]);
      setIdeationAsset(result.asset);
      setIdeationInput("");
      setPendingIdeationAsset(null);
      setIdeationModelMeta(result.model);
      try {
        await syncIdeationLinkedReferences(result.linkedReferenceImages);
      } catch {
        setError("Ideation asset uploaded, but linked reference images failed to sync.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ideation failed.");
    } finally {
      setIdeationLoading(false);
    }
  }

  async function handlePasteIdeationAsset(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter(
        (item) =>
          item.kind === "file" &&
          (item.type.startsWith("image/") || item.type.startsWith("video/")),
      )
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();

    if (ideationAssetLocked) {
      setError(
        "This ideation session already has a bound asset. You can keep chatting and the asset will be attached automatically; click \"New Shader\" to replace it.",
      );
      return;
    }

    try {
      const prepared = await prepareIdeationAsset(pastedFiles[0]);
      setPendingIdeationAsset(prepared);
      setError(
        pastedFiles.length > 1
          ? "Each ideation session can bind only one asset. The first image/video from the clipboard was used."
          : "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Asset processing failed.");
    }
  }

  function handleConfirmIdeationPrompt() {
    if (!latestIdeationPrompt.trim()) {
      return;
    }
    setInput(latestIdeationPrompt.trim());
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text: "Ideation result has been filled into the main prompt input.",
      },
    ]);
  }

  function handleRequestNewShader() {
    if (loading || !session) {
      return;
    }
    setShowNewShaderConfirm(true);
  }

  async function handleConfirmNewShader() {
    setShowNewShaderConfirm(false);
    setShowOptimizeInputDialog(false);
    setOptimizeUserInstructionInput("");
    setStartNewShaderOnNextSend(true);
    await resetIdeationMemory(true);
    setReferenceImages([]);
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text: "Confirmed: the next message will be treated as a \"New Shader\" request and will not inherit current GLSL. Ideation memory has also been reset.",
      },
    ]);
  }

  function handleCancelNewShader() {
    setShowNewShaderConfirm(false);
  }

  function buildUserChatSummary(content: string, imageCount: number): string {
    if (imageCount > 0) {
      return `${content || "(References only)"}\n[Attached ${imageCount} reference image(s)]`;
    }
    return content;
  }

  function clampParallelCount(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_PARALLEL_COUNT;
    }
    const floored = Math.floor(value);
    return Math.min(MAX_PARALLEL_COUNT, Math.max(MIN_PARALLEL_COUNT, floored));
  }

  function buildPendingSlots(batchSize: number): ShaderResultSlot[] {
    const now = Date.now();
    return Array.from({ length: batchSize }, (_, index) => ({
      slotKey: `${now}-${Math.random().toString(36).slice(2, 8)}-${index + 1}`,
      index,
      status: "pending",
      code: "",
      syncedCode: "",
      revision: null,
      optimizeHistory: [],
      optimizeCursor: 0,
    }));
  }

  function initOptimizeHistory(code: string, revision: Revision | null): OptimizeHistoryEntry[] {
    return [{ code, revision }];
  }

  function appendOptimizeHistory(
    slot: ShaderResultSlot,
    code: string,
    revision: Revision | null,
  ): { optimizeHistory: OptimizeHistoryEntry[]; optimizeCursor: number } {
    const base = slot.optimizeHistory.length > 0 ? slot.optimizeHistory : initOptimizeHistory(slot.code, slot.revision);
    const trimmed = base.slice(0, slot.optimizeCursor + 1);
    const nextHistory = [...trimmed, { code, revision }];
    return {
      optimizeHistory: nextHistory,
      optimizeCursor: nextHistory.length - 1,
    };
  }

  function applyOptimizeCursor(slot: ShaderResultSlot, cursor: number): ShaderResultSlot {
    const clamped = Math.max(0, Math.min(cursor, slot.optimizeHistory.length - 1));
    const snapshot = slot.optimizeHistory[clamped];
    if (!snapshot) {
      return slot;
    }
    return {
      ...slot,
      code: snapshot.code,
      syncedCode: snapshot.code,
      revision: snapshot.revision,
      optimizeCursor: clamped,
      status: "success",
      errorMessage: undefined,
    };
  }

  function updateSlotAt(index: number, updater: (slot: ShaderResultSlot) => ShaderResultSlot): void {
    setResultSlots((prev) =>
      prev.map((slot, slotIndex) => {
        if (slotIndex !== index) {
          return slot;
        }
        return updater(slot);
      }),
    );
  }

  async function submitGenerationBatch(
    request: GenerationRequestSnapshot,
    userChatSummary: string,
    options?: {
      clearInput?: boolean;
      clearReferenceImages?: boolean;
      updateRegenerateSnapshot?: boolean;
      parallelCountOverride?: number;
    },
  ) {
    if (!session) {
      return;
    }

    const batchSize = clampParallelCount(options?.parallelCountOverride ?? parallelCount);
    const pendingSlots = buildPendingSlots(batchSize);

    setResultSlots(pendingSlots);
    setFavoriteBySlotKey({});
    setFavoriteLoadingBySlotKey({});
    setSelectedResultIndex(0);
    setDraftShaderCode("");
    setLoading(true);
    setError("");
    setChat((prev) => [...prev, { role: "user", text: userChatSummary }]);

    let successCount = 0;
    let failureCount = 0;
    let startedNewShader = false;

    try {
      await Promise.all(
        pendingSlots.map(async (slot, slotIndex) => {
          try {
            const result = await sendMessage(session.id, request.content, {
              startNewShader: request.startNewShader,
              currentCode: request.currentCode,
              referenceImages: request.referenceImages,
              debugMode: false,
            });
            successCount += 1;
            if (result.startedNewShader) {
              startedNewShader = true;
            }
            updateSlotAt(slotIndex, (current) => ({
              ...current,
              status: "success",
              code: result.code,
              syncedCode: result.code,
              revision: result.revision,
              optimizeHistory: initOptimizeHistory(result.code, result.revision),
              optimizeCursor: 0,
              errorMessage: undefined,
            }));
          } catch (err) {
            failureCount += 1;
            const errorMessage = err instanceof Error ? err.message : "Generation failed";
            updateSlotAt(slotIndex, (current) => ({
              ...current,
              status: "error",
              errorMessage,
            }));
          }
        }),
      );

      if (options?.updateRegenerateSnapshot ?? true) {
        setLastGenerationRequest({
          content: request.content,
          startNewShader: request.startNewShader,
          currentCode: request.currentCode,
          referenceImages: request.referenceImages.map((image) => ({ dataUrl: image.dataUrl })),
          debugMode: false,
          parallelCount: batchSize,
        });
      }
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Parallel generation complete: ${batchSize} total, ${successCount} succeeded, ${failureCount} failed.`,
        },
      ]);
      if (startedNewShader) {
        setChat((prev) => [
          ...prev,
          {
            role: "assistant",
            text: "This generation did not inherit previous chat or old GLSL. Context was reset to a new starting point.",
          },
        ]);
      }
      setStartNewShaderOnNextSend(false);
      if (options?.clearInput) {
        setInput("");
      }
      if (options?.clearReferenceImages) {
        setReferenceImages([]);
      }
      if (successCount === 0 && failureCount > 0) {
        setError("All generations in this batch failed. Please check model config or try again later.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parallel generation failed");
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Parallel generation failed: please check API key and network, then retry.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handlePasteReferenceImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();

    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      setError(`You can attach up to ${MAX_REFERENCE_IMAGES} reference images.`);
      return;
    }

    setError("");
    const remainingSlots = MAX_REFERENCE_IMAGES - referenceImages.length;
    const limitedFiles = pastedFiles.slice(0, remainingSlots);

    try {
      const preparedImages = await Promise.all(limitedFiles.map((file) => prepareReferenceImage(file)));
      setReferenceImages((prev) => [...prev, ...preparedImages]);
      if (pastedFiles.length > limitedFiles.length) {
        setError(`You can attach up to ${MAX_REFERENCE_IMAGES} reference images. Extra images were ignored.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image processing failed");
    }
  }

  function handleRemoveReferenceImage(id: string) {
    setReferenceImages((prev) => prev.filter((image) => image.id !== id));
  }

  function handleRequestRegenerate() {
    if (loading || !session || !lastGenerationRequest) {
      return;
    }
    setShowRegenerateConfirm(true);
  }

  function handleCancelRegenerate() {
    setShowRegenerateConfirm(false);
  }

  function handleConfirmRegenerate() {
    if (!lastGenerationRequest) {
      setShowRegenerateConfirm(false);
      return;
    }
    setShowRegenerateConfirm(false);
    const imageCount = lastGenerationRequest.referenceImages.length;
    const summary = `${buildUserChatSummary(lastGenerationRequest.content, imageCount)}\n[Regenerate]`;
    void submitGenerationBatch(lastGenerationRequest, summary, {
      parallelCountOverride: lastGenerationRequest.parallelCount,
    });
  }

  function handleRequestOptimize() {
    if (!session || loading || !selectedSlot || !shaderCode.trim()) {
      return;
    }
    setOptimizeUserInstructionInput("");
    setShowOptimizeInputDialog(true);
  }

  function handleCancelOptimizeInput() {
    setShowOptimizeInputDialog(false);
    setOptimizeUserInstructionInput("");
  }

  async function handleSubmitOptimizeInput() {
    if (!session || loading || !selectedSlot || !shaderCode.trim()) {
      return;
    }

    const manualInstruction = optimizeUserInstructionInput.trim();
    setShowOptimizeInputDialog(false);
    setOptimizeUserInstructionInput("");

    const targetPrompt =
      lastGenerationRequest?.content.trim() || latestIdeationPrompt.trim() || input.trim();
    if (!targetPrompt) {
      setError("Missing target description. Cannot run One-Click Optimize. Send a generation request first or confirm a prompt in ideation.");
      return;
    }
    if (!previewRef.current) {
      setError("Preview is not ready. Cannot capture screenshot.");
      return;
    }

    const targetIndex = selectedResultIndex;
    const parentRevisionId = selectedSlot.revision?.id;
    const currentCode = shaderCode;

    setLoading(true);
    setError("");
    updateSlotAt(targetIndex, (slot) => ({
      ...slot,
      status: "pending",
      errorMessage: undefined,
    }));
    setChat((prev) => [
      ...prev,
      {
        role: "user",
        text: manualInstruction
          ? `One-Click Optimize: Slot #${targetIndex + 1} includes your manual instruction. Running optimize now (screenshot t=2s + asset evaluation).`
          : `One-Click Optimize: Slot #${targetIndex + 1} has no manual instruction. Gemini is generating and applying optimization now (screenshot t=2s + asset evaluation).`,
      },
    ]);

    try {
      const previewFrameDataUrl = await previewRef.current.captureAtTime(2.0);
      const suggestion = await requestOptimizeSuggestion(session.id, {
        targetPrompt,
        currentCode,
        previewFrameDataUrl,
        userInstruction: manualInstruction || undefined,
      });

      const result = await applyOptimizePrompt(session.id, {
        optimizePrompt: suggestion.optimize.prompt,
        currentCode,
        parentRevisionId,
      });
      updateSlotAt(targetIndex, (slot) => ({
        ...slot,
        status: "success",
        code: result.code,
        syncedCode: result.code,
        revision: result.revision,
        ...appendOptimizeHistory(slot, result.code, result.revision),
        errorMessage: undefined,
      }));
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${targetIndex + 1} one-click optimize completed: Revision ${result.revision.id} (${result.revision.compileStatus})\nGemini Analysis: ${suggestion.optimize.analysis}\nRequested: ${suggestion.optimize.model.requested}\nEffective: ${suggestion.optimize.model.effective}\nFallback: ${suggestion.optimize.model.fallbackUsed ? "yes" : "no"}\nLatency: ${suggestion.optimize.model.latencyMs} ms`,
        },
      ]);
    } catch (err) {
      const optimizeError = err instanceof Error ? err.message : "One-click optimize failed";
      updateSlotAt(targetIndex, (slot) => ({
        ...slot,
        status: "error",
        errorMessage: optimizeError,
      }));
      setError(optimizeError);
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${targetIndex + 1} one-click optimize failed. Please check Gemini pipeline and model config.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSelectResultSlot(index: number) {
    if (loading) {
      return;
    }
    if (index < 0 || index >= resultSlots.length) {
      return;
    }
    setSelectedResultIndex(index);
  }

  function handleUndoOptimizeVersion() {
    if (loading || !selectedSlot || !canUndoOptimize) {
      return;
    }
    const nextCursor = selectedSlot.optimizeCursor - 1;
    updateSlotAt(selectedResultIndex, (slot) => applyOptimizeCursor(slot, nextCursor));
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text: `Slot #${selectedResultIndex + 1} reverted to optimize history version ${nextCursor + 1}/${selectedSlot.optimizeHistory.length}.`,
      },
    ]);
  }

  function handleRedoOptimizeVersion() {
    if (loading || !selectedSlot || !canRedoOptimize) {
      return;
    }
    const nextCursor = selectedSlot.optimizeCursor + 1;
    updateSlotAt(selectedResultIndex, (slot) => applyOptimizeCursor(slot, nextCursor));
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text: `Slot #${selectedResultIndex + 1} redone to optimize history version ${nextCursor + 1}/${selectedSlot.optimizeHistory.length}.`,
      },
    ]);
  }

  function handleCodeEditorChange(value: string) {
    if (selectedSlot) {
      updateSlotAt(selectedResultIndex, (slot) => ({
        ...slot,
        code: value,
      }));
      return;
    }
    setDraftShaderCode(value);
  }

  async function handleDebugCode() {
    if (!session || loading) {
      return;
    }
    if (!shaderCode.trim()) {
      setError("Current GLSL is empty. Cannot run code debug.");
      return;
    }

    let targetIndex = selectedSlot ? selectedResultIndex : 0;
    if (!selectedSlot) {
      setResultSlots([
        {
          slotKey: `debug-${Date.now()}`,
          index: 0,
          status: "pending",
          code: shaderCode,
          syncedCode: shaderCode,
          revision: null,
          optimizeHistory: initOptimizeHistory(shaderCode, null),
          optimizeCursor: 0,
        },
      ]);
      setSelectedResultIndex(0);
      setDraftShaderCode("");
      targetIndex = 0;
    } else {
      updateSlotAt(targetIndex, (slot) => ({
        ...slot,
        status: "pending",
        errorMessage: undefined,
      }));
    }

    setLoading(true);
    setError("");
    setChat((prev) => [
      ...prev,
      {
        role: "user",
        text: `Code debug: fix GLSL for current slot #${targetIndex + 1} (Shadertoy convention + preview-compilable).`,
      },
    ]);

    try {
      const debugCompileErrors = Array.from(
        new Set(
          [
            previewCompileError.trim(),
            ...(selectedSlot?.revision?.compileErrors ?? []).map((item) => item.trim()),
          ].filter((item) => item.length > 0),
        ),
      ).slice(0, 20);
      const result = await sendMessage(session.id, "Debug current GLSL code and fix compile issues.", {
        startNewShader: false,
        currentCode: shaderCode,
        referenceImages: [],
        debugMode: true,
        previewCompileErrors: debugCompileErrors,
      });

      updateSlotAt(targetIndex, (slot) => ({
        ...slot,
        status: "success",
        code: result.code,
        syncedCode: result.code,
        revision: result.revision,
        errorMessage: undefined,
      }));
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${targetIndex + 1} code debug completed: Revision ${result.revision.id} (${result.revision.compileStatus})`,
        },
      ]);
    } catch (err) {
      const debugError = err instanceof Error ? err.message : "Code debug failed";
      updateSlotAt(targetIndex, (slot) => ({
        ...slot,
        status: "error",
        errorMessage: debugError,
      }));
      setError(debugError);
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${targetIndex + 1} code debug failed. Please check model and network, then retry.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function resolveFavoriteSourcePrompt(slot: ShaderResultSlot): string {
    const fromBatch = lastGenerationRequest?.content.trim();
    if (fromBatch && fromBatch.length > 0) {
      return fromBatch;
    }
    const fromRevision = slot.revision?.prompt?.trim();
    if (fromRevision && fromRevision.length > 0) {
      return fromRevision;
    }
    const fromInput = input.trim();
    if (fromInput.length > 0) {
      return fromInput;
    }
    return "Original prompt unavailable";
  }

  async function handleFavoriteSlot(index: number) {
    if (loading || !session) {
      return;
    }
    if (index < 0 || index >= resultSlots.length) {
      return;
    }
    const slot = resultSlots[index];
    if (!slot || !slot.code.trim()) {
      setError("Current result has no GLSL code to favorite.");
      return;
    }
    if (favoriteBySlotKey[slot.slotKey]) {
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${index + 1} already favorited: ${favoriteBySlotKey[slot.slotKey].name}`,
        },
      ]);
      return;
    }

    setFavoriteLoadingBySlotKey((prev) => ({ ...prev, [slot.slotKey]: true }));
    setError("");
    try {
      const coverImageDataUrl =
        index === selectedResultIndex && previewRef.current
          ? await previewRef.current.captureAtTime(0)
          : captureShaderStillFrameDataUrl({
              fragmentShader: slot.code,
              viewportWidth: DEFAULT_PREVIEW_WIDTH,
              viewportHeight: DEFAULT_PREVIEW_HEIGHT,
              seconds: 0,
            });
      const sourcePrompt = resolveFavoriteSourcePrompt(slot);
      const result = await createFavorite({
        sourcePrompt,
        code: slot.code,
        coverImageDataUrl,
        revisionId: slot.revision?.id,
        sessionId: session.id,
      });
      setFavoriteBySlotKey((prev) => ({
        ...prev,
        [slot.slotKey]: {
          id: result.favorite.id,
          name: result.favorite.name,
        },
      }));
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Slot #${index + 1} favorited as "${result.favorite.name}".`,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to favorite");
    } finally {
      setFavoriteLoadingBySlotKey((prev) => ({ ...prev, [slot.slotKey]: false }));
    }
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (!session || (input.trim().length === 0 && referenceImages.length === 0)) {
      return;
    }
    const prompt = input.trim();
    const request: GenerationRequestSnapshot = {
      content: prompt,
      startNewShader: startNewShaderOnNextSend,
      currentCode:
        !startNewShaderOnNextSend && shaderCode.trim().length > 0 ? shaderCode : undefined,
      referenceImages: referenceImages.map((image) => ({ dataUrl: image.dataUrl })),
    };
    const userMessageSummary = buildUserChatSummary(prompt, request.referenceImages.length);
    await submitGenerationBatch(request, userMessageSummary, {
      clearInput: true,
      clearReferenceImages: true,
      parallelCountOverride: parallelCount,
    });
  }

  async function handleExport() {
    if (!latestRevision) {
      return;
    }

    try {
      const file = await exportRevision(latestRevision.id);
      const blob = new Blob([file.content], { type: file.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  }

  return (
    <main className="app-shell">
      <section className="panel left-panel">
        <div className="app-title-row">
          <h1>AI Shader Tool - M1</h1>
          <div className="app-title-actions">
            <button
              type="button"
              className="favorites-entry-button"
              onClick={handleOpenLogsPage}
            >
              Logs
            </button>
            <button
              type="button"
              className="favorites-entry-button"
              onClick={handleOpenFavoritesPage}
            >
              Favorites
            </button>
          </div>
        </div>

        <div className="mode-title-row">
          <p className="mode-title">{SHADER_MODE_TITLE}</p>
        </div>
        <div className="model-active">
          <div>Active Model: {DEFAULT_USER_MODEL}</div>
        </div>
        <div className="ideation-entry">
          <button
            type="button"
            onClick={handleOpenIdeationDialog}
            disabled={loading || !session}
          >
            Open Ideation Chat
          </button>
          <span>Supports 1 image or 1 video. Gemini will refine it into a GLSL prompt.</span>
        </div>
        <p className="mode-hint">{SHADER_MODE_HINT}</p>

        <form onSubmit={handleSend} className="chat-form">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={handlePasteReferenceImages}
              placeholder="Describe the shader you want (you can paste 1-5 reference images). Example: slower flow, more red tone."
              rows={4}
              disabled={loading || !session}
            />
            <div className="input-hint">Supports Ctrl/Cmd + V to paste reference images, up to 5.</div>
            {referenceImages.length > 0 ? (
              <div className="reference-images">
                <div className="reference-images-header">
                  Attached references {referenceImages.length}/{MAX_REFERENCE_IMAGES}
                </div>
                <div className="reference-images-grid">
                  {referenceImages.map((image, index) => (
                    <div key={image.id} className="reference-image-card">
                      <img src={image.dataUrl} alt={`ref-${index + 1}`} />
                      {image.source === "ideation" ? (
                        <div className="reference-image-source">Linked from ideation</div>
                      ) : null}
                      <button
                        type="button"
                        className="reference-image-remove"
                        onClick={() => handleRemoveReferenceImage(image.id)}
                        disabled={loading}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {startNewShaderOnNextSend ? (
              <div className="armed-notice">
                The next send will generate a brand-new shader and will not inherit current GLSL.
              </div>
            ) : null}
            <div className="parallel-control">
              <label htmlFor="parallel-count">
                Parallel Count: <strong>{parallelCount}</strong>
              </label>
              <input
                id="parallel-count"
                type="range"
                min={MIN_PARALLEL_COUNT}
                max={MAX_PARALLEL_COUNT}
                step={1}
                value={parallelCount}
                onChange={(event) => setParallelCount(clampParallelCount(Number(event.target.value)))}
                disabled={loading || !session}
              />
            </div>
            <div className="actions">
              <button type="submit" disabled={!canSend}>
                {loading ? "Generating..." : "Send"}
              </button>
              <button type="button" onClick={handleRequestNewShader} disabled={loading || !session}>
                New Shader
              </button>
              <button type="button" onClick={handleExport} disabled={!latestRevision}>
                Export .glsl
              </button>
            </div>
          </form>

        {resultSlots.length > 0 || lastGenerationRequest ? (
          <div className="revision-row">
            <div className="revision-meta">
              <span>
                Current Slot: {resultSlots.length > 0 ? `#${selectedResultIndex + 1} / ${resultSlots.length}` : "-"}
              </span>
              <span>
                Slot Status: {selectedSlot ? selectedSlot.status : "Not generated"}
              </span>
              <span>
                Optimize History: {selectedSlot ? `${selectedSlot.optimizeCursor + 1}/${Math.max(1, selectedSlot.optimizeHistory.length)}` : "-"}
              </span>
              {latestRevision ? (
                <>
                  <span>Revision: {latestRevision.id}</span>
                  <span>Requested: {latestRevision.requestedModel}</span>
                  <span>Effective: {latestRevision.effectiveModel}</span>
                  <span>Fallback: {latestRevision.fallbackUsed ? "yes" : "no"}</span>
                  <span>LLM Latency: {latestRevision.llmLatencyMs} ms</span>
                  <span>Status: {latestRevision.compileStatus}</span>
                </>
              ) : (
                <span>Revision: -</span>
              )}
            </div>
            <button
              type="button"
              className="regen-button"
              onClick={handleRequestRegenerate}
              disabled={loading || !lastGenerationRequest}
            >
              Regenerate
            </button>
          </div>
        ) : null}

        {selectedSlot?.status === "error" && selectedSlot.errorMessage ? (
          <pre className="compile-error">{selectedSlot.errorMessage}</pre>
        ) : null}

        {latestRevision && latestRevision.compileErrors.length > 0 ? (
          <pre className="compile-error">{latestRevision.compileErrors.join("\n")}</pre>
        ) : null}

        {error ? <pre className="compile-error">{error}</pre> : null}

        <div className="chat-log">
          {chat.map((item, index) => (
            <div key={`${item.role}-${index}`} className={`chat-item ${item.role}`}>
              <strong>{item.role === "user" ? "You" : "System"}</strong>
              <p>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel right-panel">
        <div className="preview-toolbar">
          <h2>
            Live Preview <span className="preview-fixed-size">{DEFAULT_PREVIEW_WIDTH}x{DEFAULT_PREVIEW_HEIGHT}</span>
          </h2>
          <div className="result-tabs" role="tablist" aria-label="result-slots">
            {resultSlots.map((slot, index) => (
              <button
                key={slot.slotKey}
                type="button"
                role="tab"
                className={[
                  "result-tab",
                  index === selectedResultIndex ? "active" : "",
                  slot.status === "pending" ? "pending" : "",
                  slot.status === "error" ? "error" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleSelectResultSlot(index)}
                disabled={loading}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>
        <ShaderPreview
          ref={previewRef}
          fragmentShader={shaderCode}
          viewportWidth={DEFAULT_PREVIEW_WIDTH}
          viewportHeight={DEFAULT_PREVIEW_HEIGHT}
          onCompileErrorChange={setPreviewCompileError}
        />
        <div className="code-header">
          <div className="code-title-row">
            <h2>GLSL Code</h2>
            <button
              type="button"
              className={[
                "favorite-star-button",
                "inline",
                selectedSlotFavorite ? "active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={selectedSlotFavorite ? `Favorited: ${selectedSlotFavorite.name}` : "Favorite current slot"}
              aria-label="favorite-current-slot"
              onClick={() => handleFavoriteSlot(selectedResultIndex)}
              disabled={
                loading ||
                !selectedSlot ||
                selectedSlot.status !== "success" ||
                !shaderCode.trim() ||
                Boolean(selectedSlot && favoriteLoadingBySlotKey[selectedSlot.slotKey])
              }
            >
              {selectedSlot && favoriteLoadingBySlotKey[selectedSlot.slotKey]
                ? "…"
                : selectedSlotFavorite
                  ? "★"
                  : "☆"}
            </button>
          </div>
          <div className="code-actions">
            <button
              type="button"
              className="debug-button"
              onClick={handleUndoOptimizeVersion}
              disabled={loading || !canUndoOptimize}
              title="Undo one-click optimize history for current slot"
            >
              Undo
            </button>
            <button
              type="button"
              className="debug-button"
              onClick={handleRedoOptimizeVersion}
              disabled={loading || !canRedoOptimize}
              title="Redo one-click optimize history for current slot"
            >
              Redo
            </button>
            <button
              type="button"
              className="debug-button"
              onClick={handleDebugCode}
              disabled={loading || !session || !shaderCode.trim()}
            >
              Code Debug
            </button>
            <button
              type="button"
              className="optimize-button"
              onClick={handleRequestOptimize}
              disabled={loading || !session || !selectedSlot || !shaderCode.trim()}
            >
              One-Click Optimize
            </button>
          </div>
        </div>
        <textarea
          className="code-editor"
          value={shaderCode}
          onChange={(event) => handleCodeEditorChange(event.target.value)}
          placeholder="Waiting for shader generation..."
          spellCheck={false}
        />
        {hasLocalCodeEdits ? (
          <div className="editor-notice">Local GLSL has been edited. The next send will include current code.</div>
        ) : null}
      </section>
      {ideationDialogOpen ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel ideation-dialog">
            <div className="ideation-header">
              <h3>Ideation Chat (Gemini)</h3>
              <button type="button" onClick={handleCloseIdeationDialog}>
                Close
              </button>
            </div>
            <div className="ideation-asset-row">
              <label className={`ideation-upload ${ideationAssetLocked ? "disabled" : ""}`}>
                <input
                  type="file"
                  accept="image/*,video/*"
                  onChange={handlePickIdeationAsset}
                  disabled={ideationLoading || ideationAssetLocked}
                />
                Upload Image/Video
              </label>
              {pendingIdeationAsset ? (
                <div className="ideation-asset-pill">
                  Pending: {pendingIdeationAsset.fileName} ({pendingIdeationAsset.kind},{" "}
                  {(pendingIdeationAsset.bytes / 1024 / 1024).toFixed(2)}MB)
                  <button type="button" onClick={handleClearPendingIdeationAsset} disabled={ideationLoading}>
                    Remove
                  </button>
                </div>
              ) : null}
              {ideationAsset ? (
                <div className="ideation-asset-pill">
                  Bound Asset: {ideationAsset.fileName} ({ideationAsset.kind},{" "}
                  {(ideationAsset.bytes / 1024 / 1024).toFixed(2)}MB)
                </div>
              ) : null}
            </div>
            <div className="ideation-note">Only one asset can be bound in this session. It will be auto-attached in later rounds. Click "New Shader" to replace it.</div>
            <div className="ideation-log">
              {ideationMessages.length === 0 ? (
                <div className="ideation-empty">Discuss your target effect here first. Gemini will refine it into a prompt for GLSL generation.</div>
              ) : null}
              {ideationMessages.map((message) => (
                <div key={message.id} className={`ideation-item ${message.role}`}>
                  <strong>{message.role === "user" ? "You" : "Gemini"}</strong>
                  <p>{message.text}</p>
                  {message.role === "assistant" && message.extractedPrompt ? (
                    <pre className="ideation-prompt">{message.extractedPrompt}</pre>
                  ) : null}
                </div>
              ))}
            </div>
            {ideationModelMeta ? (
              <div className="ideation-meta">
                <span>Requested: {ideationModelMeta.requested}</span>
                <span>Effective: {ideationModelMeta.effective}</span>
                <span>Fallback: {ideationModelMeta.fallbackUsed ? "yes" : "no"}</span>
                <span>Latency: {ideationModelMeta.latencyMs} ms</span>
              </div>
            ) : null}
            <form className="ideation-form" onSubmit={handleSendIdeationMessage}>
              <textarea
                value={ideationInput}
                onChange={(event) => setIdeationInput(event.target.value)}
                onPaste={handlePasteIdeationAsset}
                placeholder="Describe the target effect, or upload an asset and send directly for Gemini to analyze first."
                rows={4}
                disabled={ideationLoading}
              />
              <div className="input-hint">Supports Ctrl/Cmd + V to paste image/video (up to 1 bound asset).</div>
              <div className="actions">
                <button type="submit" disabled={ideationLoading || (!ideationInput.trim() && !pendingIdeationAsset)}>
                  {ideationLoading ? "Refining..." : "Send"}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmIdeationPrompt}
                  disabled={!latestIdeationPrompt.trim()}
                >
                  Confirm & Fill Main Prompt
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {showNewShaderConfirm ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel">
            <h3>Confirm New Shader</h3>
            <p>
              After confirmation, the next message will be treated as a brand-new shader request and will not inherit current GLSL or previous edit history.
            </p>
            <div className="actions">
              <button type="button" onClick={handleCancelNewShader}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmNewShader}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showRegenerateConfirm ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel">
            <h3>Confirm Regenerate</h3>
            <p>After confirmation, the previous generation instruction will be sent again for a quick reroll.</p>
            <div className="actions">
              <button type="button" onClick={handleCancelRegenerate}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmRegenerate}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showOptimizeInputDialog ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel optimize-edit-dialog">
            <div className="optimize-edit-header">
              <h3>Additional One-Click Optimize Instruction (Optional)</h3>
              <button type="button" onClick={handleCancelOptimizeInput} aria-label="close-optimize-dialog">
                ×
              </button>
            </div>
            <div className="optimize-edit-meta">
              <div>
                Enter your manual adjustment notes for the current result here. After submitting, they will be
                sent together with target description, preview screenshot, and bound asset to Gemini for
                evaluation and direct optimization.
              </div>
              <div>
                If your instruction conflicts with reference image/video, your text instruction takes priority.
                Leave it empty for fully automatic Gemini decisions.
              </div>
            </div>
            <textarea
              className="optimize-edit-textarea"
              value={optimizeUserInstructionInput}
              onChange={(event) => setOptimizeUserInstructionInput(event.target.value)}
              placeholder="Example: Keep the current composition, halve the wave frequency, and strengthen the left trailing layers."
              rows={8}
              disabled={loading}
            />
            <div className="actions">
              <button type="button" onClick={handleCancelOptimizeInput} disabled={loading}>
                Cancel
              </button>
              <button type="button" onClick={handleSubmitOptimizeInput} disabled={loading}>
                Start Optimize Now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
