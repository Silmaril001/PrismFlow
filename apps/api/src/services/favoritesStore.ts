import { nanoid } from "nanoid";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { config } from "../config.js";
import {
  createObjectStorageProviderFromConfig,
  type ObjectStorageProvider,
} from "./objectStorage.js";

export interface FavoriteItem {
  id: string;
  name: string;
  sourcePrompt: string;
  promptPreview: string;
  code: string;
  coverImageDataUrl: string;
  revisionId?: string;
  sessionId?: string;
  createdAt: string;
  instructionFileName: string;
  codeFileName: string;
  archivedAt?: string;
}

export interface FavoriteHealthStatus {
  ok: boolean;
  provider: "local" | "postgres";
  detail?: string;
  storage?: {
    ok: boolean;
    provider: "none" | "s3";
    detail?: string;
  };
}

export interface FavoriteStore {
  provider: "local" | "postgres";
  listFavorites(): Promise<Array<Pick<FavoriteItem, "id" | "name" | "coverImageDataUrl" | "createdAt">>>;
  getFavoriteById(id: string): Promise<FavoriteItem | undefined>;
  createFavorite(input: {
    suggestedName: string;
    sourcePrompt: string;
    promptPreview: string;
    code: string;
    coverImageDataUrl: string;
    revisionId?: string;
    sessionId?: string;
  }): Promise<FavoriteItem>;
  renameFavoriteById(id: string, requestedName: string): Promise<FavoriteItem | undefined>;
  archiveFavoriteById(id: string): Promise<FavoriteItem | undefined>;
  healthCheck(): Promise<FavoriteHealthStatus>;
  close(): Promise<void>;
}

interface FavoriteDirs {
  root: string;
  itemsDir: string;
  instructionsDir: string;
  codesDir: string;
  archivedRoot: string;
  archivedItemsDir: string;
  archivedInstructionsDir: string;
  archivedCodesDir: string;
}

function safeFileStem(input: string): string {
  const trimmed = input.trim().replace(/[\\/:*?"<>|]/g, "");
  const normalized = trimmed.replace(/\s+/g, " ").slice(0, 48);
  return normalized.length > 0 ? normalized : "shader";
}

function allocateUniqueName(baseName: string, existingNames: Set<string>): string {
  const safeBase = safeFileStem(baseName);
  if (!existingNames.has(safeBase)) {
    return safeBase;
  }
  let index = 2;
  while (existingNames.has(`${safeBase}-${index}`)) {
    index += 1;
  }
  return `${safeBase}-${index}`;
}

function ensureFavoritesDirs(): FavoriteDirs {
  const root = config.favoritesDir;
  const itemsDir = join(root, "items");
  const instructionsDir = join(root, "instructions");
  const codesDir = join(root, "codes");
  const archivedRoot = join(root, "archived");
  const archivedItemsDir = join(archivedRoot, "items");
  const archivedInstructionsDir = join(archivedRoot, "instructions");
  const archivedCodesDir = join(archivedRoot, "codes");

  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(instructionsDir, { recursive: true });
  mkdirSync(codesDir, { recursive: true });
  mkdirSync(archivedItemsDir, { recursive: true });
  mkdirSync(archivedInstructionsDir, { recursive: true });
  mkdirSync(archivedCodesDir, { recursive: true });

  return {
    root,
    itemsDir,
    instructionsDir,
    codesDir,
    archivedRoot,
    archivedItemsDir,
    archivedInstructionsDir,
    archivedCodesDir,
  };
}

function readItemsFromDir(itemsDir: string): FavoriteItem[] {
  const names = readdirSync(itemsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const items: FavoriteItem[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(itemsDir, name), "utf8")) as FavoriteItem;
      if (parsed?.id && parsed?.name && parsed?.code) {
        items.push(parsed);
      }
    } catch {
      // Ignore malformed files.
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function writeInstructionFile(params: {
  filePath: string;
  name: string;
  promptPreview: string;
  sourcePrompt: string;
  createdAt: string;
}) {
  const instructionText = [
    `# ${params.name}`,
    "",
    "## Prompt Preview",
    params.promptPreview.trim() || "(empty)",
    "",
    "## Source Prompt",
    params.sourcePrompt.trim() || "(empty)",
    "",
    `Saved At: ${params.createdAt}`,
  ].join("\n");
  writeFileSync(params.filePath, instructionText, "utf8");
}

function writeItemJson(itemsDir: string, item: FavoriteItem) {
  writeFileSync(join(itemsDir, `${item.id}.json`), JSON.stringify(item, null, 2), "utf8");
}

class LocalFavoriteStore implements FavoriteStore {
  provider: "local" = "local";

  private listItemsRaw(): FavoriteItem[] {
    const { itemsDir } = ensureFavoritesDirs();
    return readItemsFromDir(itemsDir);
  }

  async listFavorites(): Promise<
    Array<Pick<FavoriteItem, "id" | "name" | "coverImageDataUrl" | "createdAt">>
  > {
    return this.listItemsRaw().map((item) => ({
      id: item.id,
      name: item.name,
      coverImageDataUrl: item.coverImageDataUrl,
      createdAt: item.createdAt,
    }));
  }

  async getFavoriteById(id: string): Promise<FavoriteItem | undefined> {
    return this.listItemsRaw().find((item) => item.id === id);
  }

  async createFavorite(input: {
    suggestedName: string;
    sourcePrompt: string;
    promptPreview: string;
    code: string;
    coverImageDataUrl: string;
    revisionId?: string;
    sessionId?: string;
  }): Promise<FavoriteItem> {
    const { itemsDir, instructionsDir, codesDir } = ensureFavoritesDirs();
    const existingNames = new Set(this.listItemsRaw().map((item) => item.name));
    const finalName = allocateUniqueName(input.suggestedName, existingNames);
    const id = nanoid();
    const createdAt = new Date().toISOString();
    const instructionFileName = `${finalName}.md`;
    const codeFileName = `${finalName}.glsl`;

    writeInstructionFile({
      filePath: join(instructionsDir, instructionFileName),
      name: finalName,
      promptPreview: input.promptPreview,
      sourcePrompt: input.sourcePrompt,
      createdAt,
    });
    writeFileSync(join(codesDir, codeFileName), input.code, "utf8");

    const item: FavoriteItem = {
      id,
      name: finalName,
      sourcePrompt: input.sourcePrompt,
      promptPreview: input.promptPreview,
      code: input.code,
      coverImageDataUrl: input.coverImageDataUrl,
      revisionId: input.revisionId,
      sessionId: input.sessionId,
      createdAt,
      instructionFileName,
      codeFileName,
    };
    writeItemJson(itemsDir, item);
    return item;
  }

  async renameFavoriteById(id: string, requestedName: string): Promise<FavoriteItem | undefined> {
    const dirs = ensureFavoritesDirs();
    const item = await this.getFavoriteById(id);
    if (!item) {
      return undefined;
    }

    const existingNames = new Set(
      this.listItemsRaw()
        .filter((candidate) => candidate.id !== id)
        .map((candidate) => candidate.name),
    );
    const finalName = allocateUniqueName(requestedName, existingNames);
    if (finalName === item.name) {
      return item;
    }

    const nextInstructionFileName = `${finalName}.md`;
    const nextCodeFileName = `${finalName}.glsl`;
    const oldInstructionPath = join(dirs.instructionsDir, item.instructionFileName);
    const oldCodePath = join(dirs.codesDir, item.codeFileName);
    const nextInstructionPath = join(dirs.instructionsDir, nextInstructionFileName);
    const nextCodePath = join(dirs.codesDir, nextCodeFileName);

    if (existsSync(oldInstructionPath)) {
      renameSync(oldInstructionPath, nextInstructionPath);
    }
    if (existsSync(oldCodePath)) {
      renameSync(oldCodePath, nextCodePath);
    }

    const updated: FavoriteItem = {
      ...item,
      name: finalName,
      instructionFileName: nextInstructionFileName,
      codeFileName: nextCodeFileName,
    };

    writeInstructionFile({
      filePath: nextInstructionPath,
      name: updated.name,
      promptPreview: updated.promptPreview,
      sourcePrompt: updated.sourcePrompt,
      createdAt: updated.createdAt,
    });
    writeFileSync(nextCodePath, updated.code, "utf8");
    writeItemJson(dirs.itemsDir, updated);

    return updated;
  }

  async archiveFavoriteById(id: string): Promise<FavoriteItem | undefined> {
    const dirs = ensureFavoritesDirs();
    const item = await this.getFavoriteById(id);
    if (!item) {
      return undefined;
    }

    const oldItemPath = join(dirs.itemsDir, `${item.id}.json`);
    const oldInstructionPath = join(dirs.instructionsDir, item.instructionFileName);
    const oldCodePath = join(dirs.codesDir, item.codeFileName);

    const archivedInstructionFileName = `${item.id}-${item.instructionFileName}`;
    const archivedCodeFileName = `${item.id}-${item.codeFileName}`;
    const archivedInstructionPath = join(dirs.archivedInstructionsDir, archivedInstructionFileName);
    const archivedCodePath = join(dirs.archivedCodesDir, archivedCodeFileName);
    const archivedItemPath = join(dirs.archivedItemsDir, `${item.id}.json`);

    if (existsSync(oldInstructionPath)) {
      renameSync(oldInstructionPath, archivedInstructionPath);
    }
    if (existsSync(oldCodePath)) {
      renameSync(oldCodePath, archivedCodePath);
    }

    const archivedItem: FavoriteItem = {
      ...item,
      instructionFileName: archivedInstructionFileName,
      codeFileName: archivedCodeFileName,
      archivedAt: new Date().toISOString(),
    };

    if (existsSync(oldItemPath)) {
      renameSync(oldItemPath, archivedItemPath);
    }
    writeFileSync(archivedItemPath, JSON.stringify(archivedItem, null, 2), "utf8");

    return archivedItem;
  }

  async healthCheck(): Promise<FavoriteHealthStatus> {
    return {
      ok: true,
      provider: "local",
      detail: `Using local filesystem at ${config.favoritesDir}`,
    };
  }

  async close(): Promise<void> {}
}

interface FavoriteRow {
  id: string;
  name: string;
  source_prompt: string;
  prompt_preview: string;
  code: string;
  cover_image_url: string;
  cover_image_object_key: string | null;
  revision_id: string | null;
  session_id: string | null;
  created_at: string | Date;
  instruction_file_name: string;
  code_file_name: string;
  archived_at: string | Date | null;
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapFavoriteRow(row: FavoriteRow): FavoriteItem {
  return {
    id: row.id,
    name: row.name,
    sourcePrompt: row.source_prompt,
    promptPreview: row.prompt_preview,
    code: row.code,
    coverImageDataUrl: row.cover_image_url,
    revisionId: row.revision_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: toIso(row.created_at),
    instructionFileName: row.instruction_file_name,
    codeFileName: row.code_file_name,
    archivedAt: row.archived_at ? toIso(row.archived_at) : undefined,
  };
}

class PostgresFavoriteStore implements FavoriteStore {
  provider: "postgres" = "postgres";
  private pool: Pool;
  private objectStorage: ObjectStorageProvider;

  constructor(pool: Pool, objectStorage: ObjectStorageProvider) {
    this.pool = pool;
    this.objectStorage = objectStorage;
  }

  async init(): Promise<void> {
    if (!config.postgresAutoMigrate) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_prompt TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        code TEXT NOT NULL,
        cover_image_url TEXT NOT NULL,
        cover_image_object_key TEXT,
        revision_id TEXT,
        session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        instruction_file_name TEXT NOT NULL,
        code_file_name TEXT NOT NULL,
        archived_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_favorites_active_created_at
        ON favorites (created_at DESC)
        WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_favorites_active_name
        ON favorites (name)
        WHERE archived_at IS NULL;
    `);
  }

  private async listActiveNames(excludeId?: string): Promise<Set<string>> {
    if (excludeId) {
      const result = await this.pool.query<{ name: string }>(
        `
          SELECT name
          FROM favorites
          WHERE archived_at IS NULL AND id <> $1
        `,
        [excludeId],
      );
      return new Set(result.rows.map((row) => row.name));
    }

    const result = await this.pool.query<{ name: string }>(
      `
        SELECT name
        FROM favorites
        WHERE archived_at IS NULL
      `,
    );
    return new Set(result.rows.map((row) => row.name));
  }

  async listFavorites(): Promise<
    Array<Pick<FavoriteItem, "id" | "name" | "coverImageDataUrl" | "createdAt">>
  > {
    const result = await this.pool.query<FavoriteRow>(
      `
        SELECT id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
               revision_id, session_id, created_at, instruction_file_name, code_file_name, archived_at
        FROM favorites
        WHERE archived_at IS NULL
        ORDER BY created_at DESC
      `,
    );
    return result.rows.map((row) => {
      const mapped = mapFavoriteRow(row);
      return {
        id: mapped.id,
        name: mapped.name,
        coverImageDataUrl: mapped.coverImageDataUrl,
        createdAt: mapped.createdAt,
      };
    });
  }

  async getFavoriteById(id: string): Promise<FavoriteItem | undefined> {
    const result = await this.pool.query<FavoriteRow>(
      `
        SELECT id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
               revision_id, session_id, created_at, instruction_file_name, code_file_name, archived_at
        FROM favorites
        WHERE id = $1 AND archived_at IS NULL
        LIMIT 1
      `,
      [id],
    );
    if (result.rowCount === 0) {
      return undefined;
    }
    return mapFavoriteRow(result.rows[0]);
  }

  async createFavorite(input: {
    suggestedName: string;
    sourcePrompt: string;
    promptPreview: string;
    code: string;
    coverImageDataUrl: string;
    revisionId?: string;
    sessionId?: string;
  }): Promise<FavoriteItem> {
    const existingNames = await this.listActiveNames();
    const finalName = allocateUniqueName(input.suggestedName, existingNames);
    const id = nanoid();
    const instructionFileName = `${finalName}.md`;
    const codeFileName = `${finalName}.glsl`;
    const createdAt = new Date().toISOString();

    let coverImageUrl = input.coverImageDataUrl;
    let coverImageObjectKey: string | null = null;
    if (this.objectStorage.provider !== "none") {
      const uploaded = await this.objectStorage.uploadDataUrl({
        dataUrl: input.coverImageDataUrl,
        keyPrefix: `${config.s3KeyPrefix}/favorites/covers`,
      });
      coverImageUrl = uploaded.publicUrl;
      coverImageObjectKey = uploaded.key;
    }

    const result = await this.pool.query<FavoriteRow>(
      `
        INSERT INTO favorites (
          id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
          revision_id, session_id, created_at, instruction_file_name, code_file_name
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12
        )
        RETURNING
          id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
          revision_id, session_id, created_at, instruction_file_name, code_file_name, archived_at
      `,
      [
        id,
        finalName,
        input.sourcePrompt,
        input.promptPreview,
        input.code,
        coverImageUrl,
        coverImageObjectKey,
        input.revisionId ?? null,
        input.sessionId ?? null,
        createdAt,
        instructionFileName,
        codeFileName,
      ],
    );

    return mapFavoriteRow(result.rows[0]);
  }

  async renameFavoriteById(id: string, requestedName: string): Promise<FavoriteItem | undefined> {
    const current = await this.getFavoriteById(id);
    if (!current) {
      return undefined;
    }

    const existingNames = await this.listActiveNames(id);
    const finalName = allocateUniqueName(requestedName, existingNames);
    if (finalName === current.name) {
      return current;
    }

    const instructionFileName = `${finalName}.md`;
    const codeFileName = `${finalName}.glsl`;

    const result = await this.pool.query<FavoriteRow>(
      `
        UPDATE favorites
        SET name = $2, instruction_file_name = $3, code_file_name = $4
        WHERE id = $1 AND archived_at IS NULL
        RETURNING
          id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
          revision_id, session_id, created_at, instruction_file_name, code_file_name, archived_at
      `,
      [id, finalName, instructionFileName, codeFileName],
    );

    if (result.rowCount === 0) {
      return undefined;
    }
    return mapFavoriteRow(result.rows[0]);
  }

  async archiveFavoriteById(id: string): Promise<FavoriteItem | undefined> {
    const result = await this.pool.query<FavoriteRow>(
      `
        UPDATE favorites
        SET archived_at = NOW()
        WHERE id = $1 AND archived_at IS NULL
        RETURNING
          id, name, source_prompt, prompt_preview, code, cover_image_url, cover_image_object_key,
          revision_id, session_id, created_at, instruction_file_name, code_file_name, archived_at
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return undefined;
    }
    return mapFavoriteRow(result.rows[0]);
  }

  async healthCheck(): Promise<FavoriteHealthStatus> {
    try {
      await this.pool.query("SELECT 1");
      const storage = await this.objectStorage.healthCheck();
      return {
        ok: storage.ok,
        provider: "postgres",
        detail: "Connected to PostgreSQL favorites store.",
        storage,
      };
    } catch (error) {
      return {
        ok: false,
        provider: "postgres",
        detail: error instanceof Error ? error.message : "PostgreSQL health check failed.",
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createFavoritesStore(): Promise<FavoriteStore> {
  if (config.favoritesProvider !== "postgres") {
    return new LocalFavoriteStore();
  }

  if (!config.postgresUrl) {
    throw new Error("FAVORITES_PROVIDER=postgres requires POSTGRES_URL.");
  }

  const objectStorage = createObjectStorageProviderFromConfig();
  const pool = new Pool({
    connectionString: config.postgresUrl,
    ssl: config.postgresSsl ? { rejectUnauthorized: false } : undefined,
  });

  const store = new PostgresFavoriteStore(pool, objectStorage);
  await store.init();
  return store;
}
