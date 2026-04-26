import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

dotenv.config();

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = readEnv(name);
  if (!raw) {
    return defaultValue;
  }
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function readIntegerEnv(name: string, defaultValue: number, minValue?: number): number {
  const raw = readEnv(name);
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  const integer = Math.floor(parsed);
  if (typeof minValue === "number" && integer < minValue) {
    return defaultValue;
  }
  return integer;
}

function readCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function hasProxyEnvConfigured(): boolean {
  return Boolean(
    readEnv("HTTPS_PROXY") ||
      readEnv("https_proxy") ||
      readEnv("HTTP_PROXY") ||
      readEnv("http_proxy") ||
      readEnv("ALL_PROXY") ||
      readEnv("all_proxy"),
  );
}

function applyMacSystemProxyToEnvIfNeeded(): void {
  const enabled = readBooleanEnv("USE_MACOS_SYSTEM_PROXY", true);
  if (!enabled || process.platform !== "darwin" || hasProxyEnvConfigured()) {
    return;
  }

  let proxyDump = "";
  try {
    proxyDump = execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }

  const httpsEnabled = /\bHTTPSEnable\s*:\s*1\b/.test(proxyDump);
  const httpsHost = proxyDump.match(/\bHTTPSProxy\s*:\s*([^\n]+)/)?.[1]?.trim();
  const httpsPort = proxyDump.match(/\bHTTPSPort\s*:\s*(\d+)/)?.[1]?.trim();
  const httpEnabled = /\bHTTPEnable\s*:\s*1\b/.test(proxyDump);
  const httpHost = proxyDump.match(/\bHTTPProxy\s*:\s*([^\n]+)/)?.[1]?.trim();
  const httpPort = proxyDump.match(/\bHTTPPort\s*:\s*(\d+)/)?.[1]?.trim();

  if (httpsEnabled && httpsHost && httpsPort) {
    const httpsProxy = `http://${httpsHost}:${httpsPort}`;
    process.env.HTTPS_PROXY = httpsProxy;
    process.env.https_proxy = httpsProxy;
  } else if (httpEnabled && httpHost && httpPort) {
    const httpProxy = `http://${httpHost}:${httpPort}`;
    process.env.HTTPS_PROXY = httpProxy;
    process.env.https_proxy = httpProxy;
  }

  if (httpEnabled && httpHost && httpPort) {
    const httpProxy = `http://${httpHost}:${httpPort}`;
    process.env.HTTP_PROXY = httpProxy;
    process.env.http_proxy = httpProxy;
  }

  if (!readEnv("NO_PROXY") && !readEnv("no_proxy")) {
    const noProxyDefaults = "127.0.0.1,localhost,::1";
    process.env.NO_PROXY = noProxyDefaults;
    process.env.no_proxy = noProxyDefaults;
  }
}

// Follow proxy env when available; if env is empty on macOS, import system proxy from scutil.
applyMacSystemProxyToEnvIfNeeded();
if (!process.env.NODE_USE_ENV_PROXY) {
  process.env.NODE_USE_ENV_PROXY = "1";
}

const modelFromEnv = readEnv("OPENAI_MODEL") ?? "gpt-5.5";
const timeoutFromEnv = Number(process.env.OPENAI_TIMEOUT_MS ?? "");
const inferredDefaultTimeoutMs = /xhigh/i.test(modelFromEnv) ? 90_000 : 45_000;
const openaiTimeoutMs =
  Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
    ? timeoutFromEnv
    : inferredDefaultTimeoutMs;
const maxTokensFromEnv = Number(process.env.OPENAI_MAX_TOKENS ?? "");
const openaiMaxTokens =
  Number.isFinite(maxTokensFromEnv) && maxTokensFromEnv > 0
    ? Math.floor(maxTokensFromEnv)
    : 900;
const debugModelFromEnv = readEnv("OPENAI_DEBUG_MODEL") ?? "gpt-5.4-mini";
const debugBaseUrlFromEnv =
  readEnv("OPENAI_DEBUG_BASE_URL") ??
  readEnv("OPENAI_BASE_URL") ??
  "https://api.openai.com/v1";
const openrouterApiKeyFromEnv =
  readEnv("OPENROUTER_API_KEY") ?? readEnv("openrouter_api_key");
const openrouterModelFromEnv = readEnv("OPENROUTER_MODEL") ?? "claude-opus-4.6";
const openrouterBaseUrlFromEnv =
  readEnv("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1";
const openrouterHttpRefererFromEnv = readEnv("OPENROUTER_HTTP_REFERER");
const openrouterAppNameFromEnv = readEnv("OPENROUTER_APP_NAME");
const geminiApiKeyFromEnv = readEnv("GEMINI_API_KEY") ?? readEnv("OPENAI_API_KEY");
const geminiBaseUrlFromEnv = readEnv("GEMINI_BASE_URL") ?? "https://www.right.codes/gemini/codex/v1";
const geminiModelFromEnv = readEnv("GEMINI_MODEL") ?? "gemini-3-pro-preview";
const geminiFallbackModelFromEnv = readEnv("GEMINI_FALLBACK_MODEL") ?? "gemini-3-flash-preview";
const geminiVideoModelFromEnv = readEnv("GEMINI_VIDEO_MODEL") ?? "gemini-3-flash-preview";
const geminiVideoFallbackModelFromEnv = readEnv("GEMINI_VIDEO_FALLBACK_MODEL");
const geminiOptimizeBaseUrlFromEnv = readEnv("GEMINI_OPTIMIZE_BASE_URL") ?? geminiBaseUrlFromEnv;
const geminiOptimizeModelFromEnv = readEnv("GEMINI_OPTIMIZE_MODEL") ?? geminiModelFromEnv;
const geminiOptimizeFallbackModelFromEnv =
  readEnv("GEMINI_OPTIMIZE_FALLBACK_MODEL") ?? geminiFallbackModelFromEnv;
const ffmpegBinFromEnv = readEnv("FFMPEG_BIN") ?? "ffmpeg";
const geminiVideoFrameFpsFromEnv = Number(process.env.GEMINI_VIDEO_FRAME_FPS ?? "");
const geminiVideoFrameFps =
  Number.isFinite(geminiVideoFrameFpsFromEnv) && geminiVideoFrameFpsFromEnv > 0
    ? geminiVideoFrameFpsFromEnv
    : 1;
const geminiVideoFrameMaxCountFromEnv = Number(process.env.GEMINI_VIDEO_FRAME_MAX_COUNT ?? "");
const geminiVideoFrameMaxCount =
  Number.isFinite(geminiVideoFrameMaxCountFromEnv) && geminiVideoFrameMaxCountFromEnv > 0
    ? Math.floor(geminiVideoFrameMaxCountFromEnv)
    : 6;
const geminiVideoFrameWidthFromEnv = Number(process.env.GEMINI_VIDEO_FRAME_WIDTH ?? "");
const geminiVideoFrameWidth =
  Number.isFinite(geminiVideoFrameWidthFromEnv) && geminiVideoFrameWidthFromEnv >= 240
    ? Math.floor(geminiVideoFrameWidthFromEnv)
    : 960;
const geminiTimeoutFromEnv = Number(process.env.GEMINI_TIMEOUT_MS ?? "");
const geminiTimeoutMs =
  Number.isFinite(geminiTimeoutFromEnv) && geminiTimeoutFromEnv >= 0
    ? geminiTimeoutFromEnv
    : 0;
const geminiFallbackTimeoutFromEnv = Number(process.env.GEMINI_FALLBACK_TIMEOUT_MS ?? "");
const geminiFallbackTimeoutMs =
  Number.isFinite(geminiFallbackTimeoutFromEnv) && geminiFallbackTimeoutFromEnv >= 0
    ? geminiFallbackTimeoutFromEnv
    : 0;
const geminiOptimizeTimeoutFromEnv = Number(process.env.GEMINI_OPTIMIZE_TIMEOUT_MS ?? "");
const geminiOptimizeTimeoutMs =
  Number.isFinite(geminiOptimizeTimeoutFromEnv) && geminiOptimizeTimeoutFromEnv >= 0
    ? geminiOptimizeTimeoutFromEnv
    : geminiTimeoutMs;
const geminiOptimizeFallbackTimeoutFromEnv = Number(
  process.env.GEMINI_OPTIMIZE_FALLBACK_TIMEOUT_MS ?? "",
);
const geminiOptimizeFallbackTimeoutMs =
  Number.isFinite(geminiOptimizeFallbackTimeoutFromEnv) &&
  geminiOptimizeFallbackTimeoutFromEnv >= 0
    ? geminiOptimizeFallbackTimeoutFromEnv
    : geminiFallbackTimeoutMs;
const geminiMaxOutputTokensFromEnv = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? "");
const geminiMaxOutputTokens =
  Number.isFinite(geminiMaxOutputTokensFromEnv) && geminiMaxOutputTokensFromEnv >= 0
    ? Math.floor(geminiMaxOutputTokensFromEnv)
    : 0;
const ideationAssetDirFromEnv = readEnv("IDEATION_ASSET_DIR");
const favoritesDirFromEnv = readEnv("FAVORITES_DIR");
const appStoreProviderFromEnv = readEnv("APP_STORE_PROVIDER")?.toLowerCase();
const appStoreProvider = appStoreProviderFromEnv === "postgres" ? "postgres" : "memory";
const favoritesProviderFromEnv = readEnv("FAVORITES_PROVIDER")?.toLowerCase();
const favoritesProvider = favoritesProviderFromEnv === "postgres" ? "postgres" : "local";
const postgresUrlFromEnv = readEnv("POSTGRES_URL");
const postgresSsl = readBooleanEnv("POSTGRES_SSL", false);
const postgresAutoMigrate = readBooleanEnv("POSTGRES_AUTO_MIGRATE", true);
const objectStorageProviderFromEnv = readEnv("OBJECT_STORAGE_PROVIDER")?.toLowerCase();
const objectStorageProvider = objectStorageProviderFromEnv === "s3" ? "s3" : "none";
const s3EndpointFromEnv = readEnv("S3_ENDPOINT");
const s3RegionFromEnv = readEnv("S3_REGION") ?? "auto";
const s3BucketFromEnv = readEnv("S3_BUCKET");
const s3AccessKeyIdFromEnv = readEnv("S3_ACCESS_KEY_ID");
const s3SecretAccessKeyFromEnv = readEnv("S3_SECRET_ACCESS_KEY");
const s3PublicBaseUrlFromEnv = readEnv("S3_PUBLIC_BASE_URL");
const s3ForcePathStyle = readBooleanEnv("S3_FORCE_PATH_STYLE", true);
const s3KeyPrefixFromEnv = readEnv("S3_KEY_PREFIX") ?? "prismflow";
const favoriteNamerApiKeyFromEnv =
  readEnv("FAVORITE_NAMER_API_KEY") ??
  readEnv("DEEPSEEK_API_KEY") ??
  readEnv("deepseek_api_key");
const favoriteNamerBaseUrlFromEnv =
  readEnv("FAVORITE_NAMER_BASE_URL") ??
  readEnv("DEEPSEEK_BASE_URL") ??
  "https://api.deepseek.com/v1";
const favoriteNamerModelFromEnv =
  readEnv("FAVORITE_NAMER_MODEL") ?? "deepseek-chat";
const favoriteNamerFallbackModelFromEnv = readEnv("FAVORITE_NAMER_FALLBACK_MODEL");
const favoriteNamerTimeoutFromEnv = Number(process.env.FAVORITE_NAMER_TIMEOUT_MS ?? "");
const favoriteNamerTimeoutMs =
  Number.isFinite(favoriteNamerTimeoutFromEnv) && favoriteNamerTimeoutFromEnv >= 0
    ? favoriteNamerTimeoutFromEnv
    : 20_000;
const favoriteNamerFallbackTimeoutFromEnv = Number(
  process.env.FAVORITE_NAMER_FALLBACK_TIMEOUT_MS ?? "",
);
const favoriteNamerFallbackTimeoutMs =
  Number.isFinite(favoriteNamerFallbackTimeoutFromEnv) &&
  favoriteNamerFallbackTimeoutFromEnv >= 0
    ? favoriteNamerFallbackTimeoutFromEnv
    : favoriteNamerTimeoutMs;
const promptTemplatesDirFromEnv = readEnv("PROMPT_TEMPLATES_DIR");
const defaultPromptTemplatesDir = fileURLToPath(new URL("../prompts", import.meta.url));
const defaultIdeationAssetDir = fileURLToPath(new URL("../storage/ideation", import.meta.url));
const defaultFavoritesDir = fileURLToPath(new URL("../storage/favorites", import.meta.url));
const corsAllowOriginsFromEnv = readCsvEnv("CORS_ALLOW_ORIGINS");
const defaultCorsAllowOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "https://prismflow.duckdns.org",
  "https://prismflow.146.190.104.148.sslip.io",
];
const trustProxy = readBooleanEnv("TRUST_PROXY", true);
const slowRequestThresholdMs = readIntegerEnv("SLOW_REQUEST_THRESHOLD_MS", 3000, 0);
const rateLimitEnabled = readBooleanEnv("RATE_LIMIT_ENABLED", true);
const rateLimitHeavyBurstWindowSec = readIntegerEnv("RATE_LIMIT_HEAVY_BURST_WINDOW_SEC", 10, 1);
const rateLimitHeavyBurstMax = readIntegerEnv("RATE_LIMIT_HEAVY_BURST_MAX", 2, 1);
const rateLimitHeavyWindowSec = readIntegerEnv("RATE_LIMIT_HEAVY_WINDOW_SEC", 60, 1);
const rateLimitHeavyMax = readIntegerEnv("RATE_LIMIT_HEAVY_MAX", 6, 1);
const rateLimitGenerateBurstWindowSec = readIntegerEnv(
  "RATE_LIMIT_GENERATE_BURST_WINDOW_SEC",
  10,
  1,
);
const rateLimitGenerateBurstMax = readIntegerEnv("RATE_LIMIT_GENERATE_BURST_MAX", 10, 1);
const rateLimitGenerateWindowSec = readIntegerEnv("RATE_LIMIT_GENERATE_WINDOW_SEC", 60, 1);
const rateLimitGenerateMax = readIntegerEnv("RATE_LIMIT_GENERATE_MAX", 30, 1);
const rateLimitLightWindowSec = readIntegerEnv("RATE_LIMIT_LIGHT_WINDOW_SEC", 60, 1);
const rateLimitLightMax = readIntegerEnv("RATE_LIMIT_LIGHT_MAX", 120, 1);
const rateLimitFavoritesManualWindowSec = readIntegerEnv(
  "RATE_LIMIT_FAVORITES_MANUAL_WINDOW_SEC",
  3600,
  1,
);
const rateLimitFavoritesManualMax = readIntegerEnv("RATE_LIMIT_FAVORITES_MANUAL_MAX", 5, 1);
const favoritesDuplicateWindowSec = readIntegerEnv("FAVORITES_DUPLICATE_WINDOW_SEC", 3600, 1);
const sessionConcurrencyMax = readIntegerEnv("SESSION_CONCURRENCY_MAX", 1, 1);
const sessionMessageConcurrencyMax = readIntegerEnv("SESSION_MESSAGE_CONCURRENCY_MAX", 10, 1);

export const config = {
  port: Number(process.env.PORT ?? 8787),
  trustProxy,
  corsAllowOrigins: corsAllowOriginsFromEnv ?? defaultCorsAllowOrigins,
  slowRequestThresholdMs,
  rateLimitEnabled,
  rateLimitHeavyBurstWindowSec,
  rateLimitHeavyBurstMax,
  rateLimitHeavyWindowSec,
  rateLimitHeavyMax,
  rateLimitGenerateBurstWindowSec,
  rateLimitGenerateBurstMax,
  rateLimitGenerateWindowSec,
  rateLimitGenerateMax,
  rateLimitLightWindowSec,
  rateLimitLightMax,
  rateLimitFavoritesManualWindowSec,
  rateLimitFavoritesManualMax,
  favoritesDuplicateWindowSec,
  sessionConcurrencyMax,
  sessionMessageConcurrencyMax,
  openaiApiKey: readEnv("OPENAI_API_KEY"),
  openaiModel: modelFromEnv,
  openaiBaseUrl: readEnv("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
  openaiDebugModel: debugModelFromEnv,
  openaiDebugBaseUrl: debugBaseUrlFromEnv,
  openaiTimeoutMs,
  openaiMaxTokens,
  openrouterApiKey: openrouterApiKeyFromEnv,
  openrouterModel: openrouterModelFromEnv,
  openrouterBaseUrl: openrouterBaseUrlFromEnv,
  openrouterHttpReferer: openrouterHttpRefererFromEnv,
  openrouterAppName: openrouterAppNameFromEnv,
  geminiApiKey: geminiApiKeyFromEnv,
  geminiBaseUrl: geminiBaseUrlFromEnv,
  geminiModel: geminiModelFromEnv,
  geminiFallbackModel: geminiFallbackModelFromEnv,
  geminiVideoModel: geminiVideoModelFromEnv,
  geminiVideoFallbackModel: geminiVideoFallbackModelFromEnv,
  geminiOptimizeBaseUrl: geminiOptimizeBaseUrlFromEnv,
  geminiOptimizeModel: geminiOptimizeModelFromEnv,
  geminiOptimizeFallbackModel: geminiOptimizeFallbackModelFromEnv,
  ffmpegBin: ffmpegBinFromEnv,
  geminiVideoFrameFps,
  geminiVideoFrameMaxCount,
  geminiVideoFrameWidth,
  geminiTimeoutMs,
  geminiFallbackTimeoutMs,
  geminiOptimizeTimeoutMs,
  geminiOptimizeFallbackTimeoutMs,
  geminiMaxOutputTokens,
  ideationAssetDir: ideationAssetDirFromEnv ?? defaultIdeationAssetDir,
  favoritesDir: favoritesDirFromEnv ?? defaultFavoritesDir,
  appStoreProvider,
  favoritesProvider,
  postgresUrl: postgresUrlFromEnv,
  postgresSsl,
  postgresAutoMigrate,
  objectStorageProvider,
  s3Endpoint: s3EndpointFromEnv,
  s3Region: s3RegionFromEnv,
  s3Bucket: s3BucketFromEnv,
  s3AccessKeyId: s3AccessKeyIdFromEnv,
  s3SecretAccessKey: s3SecretAccessKeyFromEnv,
  s3PublicBaseUrl: s3PublicBaseUrlFromEnv,
  s3ForcePathStyle,
  s3KeyPrefix: s3KeyPrefixFromEnv,
  favoriteNamerApiKey: favoriteNamerApiKeyFromEnv,
  favoriteNamerBaseUrl: favoriteNamerBaseUrlFromEnv,
  favoriteNamerModel: favoriteNamerModelFromEnv,
  favoriteNamerFallbackModel: favoriteNamerFallbackModelFromEnv,
  favoriteNamerTimeoutMs,
  favoriteNamerFallbackTimeoutMs,
  promptTemplatesDir: promptTemplatesDirFromEnv ?? defaultPromptTemplatesDir,
};
