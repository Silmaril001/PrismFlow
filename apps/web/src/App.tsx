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
  type LlmChannel,
  type ReferenceImageInput,
  type Mode,
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

const MODE_COPY: Record<Mode, { title: string; hint: string }> = {
  shader_glsl: {
    title: "程序化 Shader 模式 (GLSL)",
    hint: "适用于发光动效、消融、流体规律、全息扫描等数学驱动视觉。",
  },
  pbr_texture: {
    title: "PBR 材质生成模式 (纹理组)",
    hint: "适用于写实地砖、金属锈迹、木纹、布料、浮雕等物理表面特征。",
  },
};

const INITIAL_PROMPT = "做一个蓝色能量流动的全屏 Shader，节奏平稳。";
const DEFAULT_PREVIEW_WIDTH = 960;
const DEFAULT_PREVIEW_HEIGHT = 540;
const MIN_PARALLEL_COUNT = 1;
const MAX_PARALLEL_COUNT = 10;
const DEFAULT_PARALLEL_COUNT = 5;
const DEFAULT_CHANNEL: LlmChannel = "rightcode";
const DEFAULT_USER_MODEL = "gpt-5.4-medium";
const DEFAULT_USER_BASE_URL = "https://www.right.codes/codex/v1";
const DEFAULT_OPENROUTER_MODEL = "claude-opus-4.6";
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
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("解析图片失败。"));
    img.src = dataUrl;
  });
}

async function prepareReferenceImage(file: File): Promise<ReferenceImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("仅支持图片粘贴。");
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
    throw new Error("浏览器不支持图片预处理。");
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
    throw new Error("图片过大，请粘贴更小的图片（单张建议不超过 1.5MB）。");
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
    throw new Error("仅支持上传图片或视频。");
  }
  if (file.size > MAX_IDEATION_ASSET_BYTES) {
    throw new Error("素材过大，请控制在 25MB 以内。");
  }
  const dataUrl = await readFileAsDataUrl(file);
  const bytes = estimateDataUrlBytes(dataUrl);
  if (bytes > MAX_IDEATION_ASSET_BYTES) {
    throw new Error("素材编码后超过 25MB，请换更小文件。");
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
  const [mode, setMode] = useState<Mode>("shader_glsl");
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
  const [appliedChannel, setAppliedChannel] = useState<LlmChannel>(DEFAULT_CHANNEL);
  const [modelInput, setModelInput] = useState(DEFAULT_USER_MODEL);
  const [appliedRightcodeModel, setAppliedRightcodeModel] = useState(DEFAULT_USER_MODEL);
  const [appliedOpenrouterModel, setAppliedOpenrouterModel] = useState(DEFAULT_OPENROUTER_MODEL);
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_USER_BASE_URL);
  const [appliedRightcodeBaseUrl, setAppliedRightcodeBaseUrl] = useState(DEFAULT_USER_BASE_URL);
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
        const created = await createSession(mode);
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
          setError(err instanceof Error ? err.message : "会话创建失败");
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
  }, [mode]);

  const modeHint = useMemo(() => MODE_COPY[mode], [mode]);
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

  async function syncIdeationLinkedReferences(dataUrls: string[]) {
    const limited = dataUrls.slice(0, MAX_REFERENCE_IMAGES);
    const prepared = await Promise.all(limited.map((dataUrl) => prepareLinkedReferenceImage(dataUrl)));
    setReferenceImages((prev) => {
      const manual = prev.filter((image) => image.source !== "ideation");
      const slotsForManual = Math.max(0, MAX_REFERENCE_IMAGES - prepared.length);
      return [...manual.slice(0, slotsForManual), ...prepared];
    });
    if (dataUrls.length > limited.length) {
      setError(`提炼素材联动参考图最多展示 ${MAX_REFERENCE_IMAGES} 张，已自动截断。`);
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
            text: "需求提炼弹窗的聊天记录和上传素材已重置。",
          },
        ]);
      }
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "重置需求提炼会话失败。");
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
      setError("当前需求提炼会话已绑定素材。你可以继续对话，系统会自动附带该素材；如需更换请点击“新 Shader”。");
      return;
    }

    try {
      const prepared = await prepareIdeationAsset(picked);
      setPendingIdeationAsset(prepared);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "素材处理失败。");
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
        setError("提炼素材已上传，但联动参考图同步失败。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "需求提炼失败。");
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
      setError("当前需求提炼会话已绑定素材。你可以继续对话，系统会自动附带该素材；如需更换请点击“新 Shader”。");
      return;
    }

    try {
      const prepared = await prepareIdeationAsset(pastedFiles[0]);
      setPendingIdeationAsset(prepared);
      setError(
        pastedFiles.length > 1
          ? "需求提炼会话每次仅能绑定一份素材，已采用剪贴板中的第一份图片/视频。"
          : "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "素材处理失败。");
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
        text: "已将需求提炼结果回填到主描述输入框。",
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
        text: "已确认：下一条消息将按“新 Shader”处理，不继承当前 GLSL。需求提炼弹窗的记忆也已重置。",
      },
    ]);
  }

  function handleCancelNewShader() {
    setShowNewShaderConfirm(false);
  }

  function handleApplyModel() {
    const nextModel = modelInput.trim();
    if (!nextModel) {
      setError("模型名不能为空。");
      return;
    }
    if (appliedChannel === "rightcode") {
      const nextBaseUrl = baseUrlInput.trim();
      if (!nextBaseUrl) {
        setError("Base URL 不能为空。");
        return;
      }
      try {
        new URL(nextBaseUrl);
      } catch {
        setError("Base URL 格式不正确，请输入完整 URL（例如 https://www.right.codes/codex/v1）。");
        return;
      }
      setAppliedRightcodeModel(nextModel);
      setAppliedRightcodeBaseUrl(nextBaseUrl);
      setError("");
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `已应用 rightcode 模型：${nextModel}\n已应用 Base URL：${nextBaseUrl}\n下一次发送和重新生成将使用这组配置。`,
        },
      ]);
      return;
    }

    setAppliedOpenrouterModel(nextModel);
    setError("");
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text: `已应用 openrouter 模型：${nextModel}\nopenrouter 渠道仍固定走服务端 OPENROUTER_BASE_URL，UI 的 Base URL 输入不会生效。`,
      },
    ]);
  }

  function handleSwitchChannel(channel: LlmChannel) {
    if (loading || !session || appliedChannel === channel) {
      return;
    }
    setAppliedChannel(channel);
    if (channel === "rightcode") {
      setModelInput(appliedRightcodeModel);
      setBaseUrlInput(appliedRightcodeBaseUrl);
    } else {
      setModelInput(appliedOpenrouterModel);
    }
    setError("");
    setChat((prev) => [
      ...prev,
      {
        role: "assistant",
        text:
          channel === "openrouter"
            ? `已切换渠道到 openrouter。后续发送和重新生成将使用当前 openrouter 模型（当前：${appliedOpenrouterModel || DEFAULT_OPENROUTER_MODEL}）；UI 的 Base URL 输入不会生效。`
            : "已切换渠道到 rightcode。后续发送和重新生成将使用你当前应用的模型和 Base URL。",
      },
    ]);
  }

  function buildUserChatSummary(content: string, imageCount: number): string {
    if (imageCount > 0) {
      return `${content || "(仅参考图)"}\n[附带 ${imageCount} 张参考图]`;
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

  function resolveRequestTransport(options?: {
    channelOverride?: LlmChannel;
    modelOverride?: string;
    baseUrlOverride?: string;
    debugMode?: boolean;
  }): {
    channelForRequest: LlmChannel;
    modelForRequest: string;
    baseUrlForRequest?: string;
  } {
    const debugMode = options?.debugMode ?? false;
    const channelForRequest = options?.channelOverride ?? appliedChannel;
    const useRightcodeOverrides = channelForRequest === "rightcode" || debugMode;
    const modelForRequest = useRightcodeOverrides
      ? options?.modelOverride?.trim() || appliedRightcodeModel.trim() || DEFAULT_USER_MODEL
      : options?.modelOverride?.trim() || appliedOpenrouterModel.trim() || DEFAULT_OPENROUTER_MODEL;
    const baseUrlForRequest = useRightcodeOverrides
      ? options?.baseUrlOverride?.trim() || appliedRightcodeBaseUrl.trim() || DEFAULT_USER_BASE_URL
      : undefined;
    return {
      channelForRequest,
      modelForRequest,
      baseUrlForRequest,
    };
  }

  async function submitGenerationBatch(
    request: GenerationRequestSnapshot,
    userChatSummary: string,
    options?: {
      clearInput?: boolean;
      clearReferenceImages?: boolean;
      channelOverride?: LlmChannel;
      modelOverride?: string;
      baseUrlOverride?: string;
      updateRegenerateSnapshot?: boolean;
      parallelCountOverride?: number;
    },
  ) {
    if (!session) {
      return;
    }

    const batchSize = clampParallelCount(options?.parallelCountOverride ?? parallelCount);
    const { channelForRequest, modelForRequest, baseUrlForRequest } = resolveRequestTransport({
      channelOverride: options?.channelOverride,
      modelOverride: options?.modelOverride,
      baseUrlOverride: options?.baseUrlOverride,
      debugMode: false,
    });
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
              channel: channelForRequest,
              model: modelForRequest,
              baseUrl: baseUrlForRequest,
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
            const errorMessage = err instanceof Error ? err.message : "生成失败";
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
          text: `并行生成完成：共 ${batchSize} 份，成功 ${successCount}，失败 ${failureCount}。`,
        },
      ]);
      if (startedNewShader) {
        setChat((prev) => [
          ...prev,
          {
            role: "assistant",
            text: "本次生成未继承历史沟通和旧 GLSL，上下文已重置为新起点。",
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
        setError("本批次全部生成失败，请检查模型配置或稍后重试。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "并行生成失败");
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "并行生成失败：请检查 API Key、模型名和 Base URL 配置。",
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
      setError(`最多只能附带 ${MAX_REFERENCE_IMAGES} 张参考图。`);
      return;
    }

    setError("");
    const remainingSlots = MAX_REFERENCE_IMAGES - referenceImages.length;
    const limitedFiles = pastedFiles.slice(0, remainingSlots);

    try {
      const preparedImages = await Promise.all(limitedFiles.map((file) => prepareReferenceImage(file)));
      setReferenceImages((prev) => [...prev, ...preparedImages]);
      if (pastedFiles.length > limitedFiles.length) {
        setError(`最多只能附带 ${MAX_REFERENCE_IMAGES} 张参考图，其余图片已忽略。`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片处理失败");
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
    const summary = `${buildUserChatSummary(lastGenerationRequest.content, imageCount)}\n[重新生成]`;
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
      setError("缺少目标描述，无法执行一键优化。请先发送一次生成请求或先在需求提炼中确认提示词。");
      return;
    }
    if (!previewRef.current) {
      setError("预览器尚未就绪，无法截图。");
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
          ? `一键优化：编号 #${targetIndex + 1} 已附加你的修改意见，正在自动生成并执行优化（截图 t=2s + 素材评估）。`
          : `一键优化：编号 #${targetIndex + 1} 未附加手动意见，正在由 Gemini 自动生成并执行优化（截图 t=2s + 素材评估）。`,
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

      const { channelForRequest, modelForRequest, baseUrlForRequest } = resolveRequestTransport({
        debugMode: false,
      });
      const result = await applyOptimizePrompt(session.id, {
        optimizePrompt: suggestion.optimize.prompt,
        currentCode,
        channel: channelForRequest,
        model: modelForRequest,
        baseUrl: baseUrlForRequest,
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
          text: `编号 #${targetIndex + 1} 一键优化完成：Revision ${result.revision.id} (${result.revision.compileStatus})\nGemini评估：${suggestion.optimize.analysis}\nRequested: ${suggestion.optimize.model.requested}\nEffective: ${suggestion.optimize.model.effective}\nFallback: ${suggestion.optimize.model.fallbackUsed ? "yes" : "no"}\nLatency: ${suggestion.optimize.model.latencyMs} ms`,
        },
      ]);
    } catch (err) {
      const optimizeError = err instanceof Error ? err.message : "一键优化失败";
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
          text: `编号 #${targetIndex + 1} 一键优化失败，请检查 Gemini 链路和模型配置。`,
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
        text: `编号 #${selectedResultIndex + 1} 已回退到优化历史版本 ${nextCursor + 1}/${selectedSlot.optimizeHistory.length}。`,
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
        text: `编号 #${selectedResultIndex + 1} 已重做到优化历史版本 ${nextCursor + 1}/${selectedSlot.optimizeHistory.length}。`,
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
      setError("当前 GLSL 为空，无法执行代码 debug。");
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

    const { channelForRequest, modelForRequest, baseUrlForRequest } = resolveRequestTransport({
      debugMode: true,
    });

    setLoading(true);
    setError("");
    setChat((prev) => [
      ...prev,
      {
        role: "user",
        text: `代码 debug：修复当前编号 #${targetIndex + 1} 的 GLSL（Shadertoy 约定 + 预览可编译）`,
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
        channel: channelForRequest,
        model: modelForRequest,
        baseUrl: baseUrlForRequest,
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
          text: `编号 #${targetIndex + 1} 已完成代码 debug：Revision ${result.revision.id} (${result.revision.compileStatus})`,
        },
      ]);
    } catch (err) {
      const debugError = err instanceof Error ? err.message : "代码 debug 失败";
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
          text: `编号 #${targetIndex + 1} 代码 debug 失败，请检查模型和网络后重试。`,
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
    return "未提供原始提示词";
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
      setError("当前结果没有可收藏的 GLSL 代码。");
      return;
    }
    if (favoriteBySlotKey[slot.slotKey]) {
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `编号 #${index + 1} 已收藏：${favoriteBySlotKey[slot.slotKey].name}`,
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
          text: `编号 #${index + 1} 已收藏为「${result.favorite.name}」。`,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "收藏失败");
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
      setError(err instanceof Error ? err.message : "导出失败");
    }
  }

  return (
    <main className="app-shell">
      <section className="panel left-panel">
        <div className="app-title-row">
          <h1>AI Shader Tool - M1</h1>
          <button
            type="button"
            className="favorites-entry-button"
            onClick={handleOpenFavoritesPage}
          >
            收藏页
          </button>
        </div>
        <div className="mode-switch">
          <button
            className={mode === "shader_glsl" ? "active" : ""}
            onClick={() => setMode("shader_glsl")}
          >
            Shader
          </button>
          <button
            className={mode === "pbr_texture" ? "active" : ""}
            onClick={() => setMode("pbr_texture")}
          >
            PBR
          </button>
        </div>

        <div className="mode-title-row">
          <p className="mode-title">{modeHint.title}</p>
          {mode === "shader_glsl" ? (
            <div className="model-controls">
              <div className="channel-switch">
                <button
                  type="button"
                  className={appliedChannel === "rightcode" ? "active" : ""}
                  onClick={() => handleSwitchChannel("rightcode")}
                  disabled={loading || !session}
                >
                  rightcode
                </button>
                <button
                  type="button"
                  className={appliedChannel === "openrouter" ? "active" : ""}
                  onClick={() => handleSwitchChannel("openrouter")}
                  disabled={loading || !session}
                >
                  openrouter
                </button>
              </div>
              <input
                type="text"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                aria-label="model-name"
                title="模型名称"
                placeholder={appliedChannel === "rightcode" ? DEFAULT_USER_MODEL : DEFAULT_OPENROUTER_MODEL}
                disabled={loading || !session}
              />
              <input
                type="text"
                value={baseUrlInput}
                onChange={(event) => setBaseUrlInput(event.target.value)}
                aria-label="base-url"
                title="Base URL"
                placeholder={DEFAULT_USER_BASE_URL}
                disabled={loading || !session || appliedChannel !== "rightcode"}
              />
              <button
                type="button"
                onClick={handleApplyModel}
                disabled={loading || !session}
              >
                应用
              </button>
            </div>
          ) : null}
        </div>
        {mode === "shader_glsl" ? (
          <div className="model-active">
            <div>当前渠道：{appliedChannel}</div>
            {appliedChannel === "rightcode" ? (
              <>
                <div>当前模型：{appliedRightcodeModel}</div>
                <div>当前 Base URL：{appliedRightcodeBaseUrl}</div>
              </>
            ) : (
              <>
                <div>当前模型：{appliedOpenrouterModel || DEFAULT_OPENROUTER_MODEL}</div>
                <div>openrouter 固定使用服务端 OPENROUTER_BASE_URL（UI Base URL 不生效）。</div>
              </>
            )}
          </div>
        ) : null}
        {mode === "shader_glsl" ? (
          <div className="ideation-entry">
            <button
              type="button"
              onClick={handleOpenIdeationDialog}
              disabled={loading || !session}
            >
              打开需求提炼 Chat
            </button>
            <span>支持 1 张图片或 1 段视频，基于 Gemini 提炼 GLSL 提示词。</span>
          </div>
        ) : null}
        <p className="mode-hint">{modeHint.hint}</p>

        {mode === "pbr_texture" ? (
          <div className="notice-box">
            PBR 管线已预留接口，但 M1 未启用。请切回 Shader 模式继续。
          </div>
        ) : (
          <form onSubmit={handleSend} className="chat-form">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={handlePasteReferenceImages}
              placeholder="描述你想要的 Shader（可直接粘贴 1-5 张参考图）。例如：流速慢一点，颜色偏红。"
              rows={4}
              disabled={loading || !session}
            />
            <div className="input-hint">支持 Ctrl/Cmd + V 粘贴参考图，最多 5 张。</div>
            {referenceImages.length > 0 ? (
              <div className="reference-images">
                <div className="reference-images-header">
                  已附带参考图 {referenceImages.length}/{MAX_REFERENCE_IMAGES}
                </div>
                <div className="reference-images-grid">
                  {referenceImages.map((image, index) => (
                    <div key={image.id} className="reference-image-card">
                      <img src={image.dataUrl} alt={`ref-${index + 1}`} />
                      {image.source === "ideation" ? (
                        <div className="reference-image-source">提炼联动</div>
                      ) : null}
                      <button
                        type="button"
                        className="reference-image-remove"
                        onClick={() => handleRemoveReferenceImage(image.id)}
                        disabled={loading}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {startNewShaderOnNextSend ? (
              <div className="armed-notice">
                下一条发送将作为全新 Shader 生成，不继承当前 GLSL。
              </div>
            ) : null}
            <div className="parallel-control">
              <label htmlFor="parallel-count">
                并行生成数量：<strong>{parallelCount}</strong>
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
                {loading ? "生成中..." : "发送"}
              </button>
              <button type="button" onClick={handleRequestNewShader} disabled={loading || !session}>
                新 Shader
              </button>
              <button type="button" onClick={handleExport} disabled={!latestRevision}>
                导出 .glsl
              </button>
            </div>
          </form>
        )}

        {resultSlots.length > 0 || lastGenerationRequest ? (
          <div className="revision-row">
            <div className="revision-meta">
              <span>
                当前编号：{resultSlots.length > 0 ? `#${selectedResultIndex + 1} / ${resultSlots.length}` : "-"}
              </span>
              <span>
                槽位状态：{selectedSlot ? selectedSlot.status : "未生成"}
              </span>
              <span>
                优化历史：{selectedSlot ? `${selectedSlot.optimizeCursor + 1}/${Math.max(1, selectedSlot.optimizeHistory.length)}` : "-"}
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
              重新生成
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
              <strong>{item.role === "user" ? "你" : "系统"}</strong>
              <p>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel right-panel">
        <div className="preview-toolbar">
          <h2>
            实时预览 <span className="preview-fixed-size">{DEFAULT_PREVIEW_WIDTH}x{DEFAULT_PREVIEW_HEIGHT}</span>
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
            <h2>GLSL 代码</h2>
            <button
              type="button"
              className={[
                "favorite-star-button",
                "inline",
                selectedSlotFavorite ? "active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={selectedSlotFavorite ? `已收藏：${selectedSlotFavorite.name}` : "收藏当前编号"}
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
              title="回退当前编号的一键优化历史"
            >
              回退
            </button>
            <button
              type="button"
              className="debug-button"
              onClick={handleRedoOptimizeVersion}
              disabled={loading || !canRedoOptimize}
              title="重做当前编号的一键优化历史"
            >
              重做
            </button>
            <button
              type="button"
              className="debug-button"
              onClick={handleDebugCode}
              disabled={loading || !session || !shaderCode.trim()}
            >
              代码debug
            </button>
            <button
              type="button"
              className="optimize-button"
              onClick={handleRequestOptimize}
              disabled={loading || !session || !selectedSlot || !shaderCode.trim()}
            >
              一键优化
            </button>
          </div>
        </div>
        <textarea
          className="code-editor"
          value={shaderCode}
          onChange={(event) => handleCodeEditorChange(event.target.value)}
          placeholder="等待生成 shader..."
          spellCheck={false}
        />
        {hasLocalCodeEdits ? (
          <div className="editor-notice">本地 GLSL 已修改，下一次发送会带上当前代码。</div>
        ) : null}
      </section>
      {ideationDialogOpen ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel ideation-dialog">
            <div className="ideation-header">
              <h3>需求提炼 Chat（Gemini）</h3>
              <button type="button" onClick={handleCloseIdeationDialog}>
                关闭
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
                上传图片/视频
              </label>
              {pendingIdeationAsset ? (
                <div className="ideation-asset-pill">
                  待上传：{pendingIdeationAsset.fileName} ({pendingIdeationAsset.kind},{" "}
                  {(pendingIdeationAsset.bytes / 1024 / 1024).toFixed(2)}MB)
                  <button type="button" onClick={handleClearPendingIdeationAsset} disabled={ideationLoading}>
                    移除
                  </button>
                </div>
              ) : null}
              {ideationAsset ? (
                <div className="ideation-asset-pill">
                  已绑定素材：{ideationAsset.fileName} ({ideationAsset.kind},{" "}
                  {(ideationAsset.bytes / 1024 / 1024).toFixed(2)}MB)
                </div>
              ) : null}
            </div>
            <div className="ideation-note">当前会话仅允许绑定一份素材；后续每轮会自动附带。需替换时点击“新 Shader”。</div>
            <div className="ideation-log">
              {ideationMessages.length === 0 ? (
                <div className="ideation-empty">在这里先沟通目标效果，Gemini 会提炼成可用于 GLSL 生成的提示词。</div>
              ) : null}
              {ideationMessages.map((message) => (
                <div key={message.id} className={`ideation-item ${message.role}`}>
                  <strong>{message.role === "user" ? "你" : "Gemini"}</strong>
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
                placeholder="描述目标效果，或只上传素材后直接发送让 Gemini 先分析。"
                rows={4}
                disabled={ideationLoading}
              />
              <div className="input-hint">支持 Ctrl/Cmd + V 粘贴图片或视频（最多绑定 1 份素材）。</div>
              <div className="actions">
                <button type="submit" disabled={ideationLoading || (!ideationInput.trim() && !pendingIdeationAsset)}>
                  {ideationLoading ? "提炼中..." : "发送"}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmIdeationPrompt}
                  disabled={!latestIdeationPrompt.trim()}
                >
                  确认并填入主描述
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {showNewShaderConfirm ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel">
            <h3>确认创建新 Shader</h3>
            <p>
              确认后，下一条消息会被当作全新 Shader 需求，不继承当前 GLSL 和之前的修改链。
            </p>
            <div className="actions">
              <button type="button" onClick={handleCancelNewShader}>
                取消
              </button>
              <button type="button" onClick={handleConfirmNewShader}>
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showRegenerateConfirm ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel">
            <h3>确认重新生成</h3>
            <p>确认后将按上一条生成指令重新请求一次，用于快速抽卡。</p>
            <div className="actions">
              <button type="button" onClick={handleCancelRegenerate}>
                取消
              </button>
              <button type="button" onClick={handleConfirmRegenerate}>
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showOptimizeInputDialog ? (
        <div className="dialog-backdrop">
          <div className="dialog-panel optimize-edit-dialog">
            <div className="optimize-edit-header">
              <h3>一键优化补充意见（可选）</h3>
              <button type="button" onClick={handleCancelOptimizeInput} aria-label="close-optimize-dialog">
                ×
              </button>
            </div>
            <div className="optimize-edit-meta">
              <div>
                这里填写你对当前结果的人工干预意见。提交后会和目标描述、预览截图、绑定素材一起交给
                Gemini 评估并直接执行优化。
              </div>
              <div>
                若你的意见与参考图/视频冲突，系统会以你的文字意见为主；留空则完全由 Gemini 自主决策。
              </div>
            </div>
            <textarea
              className="optimize-edit-textarea"
              value={optimizeUserInstructionInput}
              onChange={(event) => setOptimizeUserInstructionInput(event.target.value)}
              placeholder="例如：保留现在的构图，但把波动频率减半，并强化左侧拖影层次。"
              rows={8}
              disabled={loading}
            />
            <div className="actions">
              <button type="button" onClick={handleCancelOptimizeInput} disabled={loading}>
                取消
              </button>
              <button type="button" onClick={handleSubmitOptimizeInput} disabled={loading}>
                直接开始优化
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
