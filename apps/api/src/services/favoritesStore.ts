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
import { config } from "../config.js";

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

function listItemsRaw(): FavoriteItem[] {
  const { itemsDir } = ensureFavoritesDirs();
  return readItemsFromDir(itemsDir);
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
    params.promptPreview.trim() || "（空）",
    "",
    "## Source Prompt",
    params.sourcePrompt.trim() || "（空）",
    "",
    `Saved At: ${params.createdAt}`,
  ].join("\n");
  writeFileSync(params.filePath, instructionText, "utf8");
}

function writeItemJson(itemsDir: string, item: FavoriteItem) {
  writeFileSync(join(itemsDir, `${item.id}.json`), JSON.stringify(item, null, 2), "utf8");
}

export function listFavorites(): Array<
  Pick<FavoriteItem, "id" | "name" | "coverImageDataUrl" | "createdAt">
> {
  return listItemsRaw().map((item) => ({
    id: item.id,
    name: item.name,
    coverImageDataUrl: item.coverImageDataUrl,
    createdAt: item.createdAt,
  }));
}

export function getFavoriteById(id: string): FavoriteItem | undefined {
  return listItemsRaw().find((item) => item.id === id);
}

export function createFavorite(input: {
  suggestedName: string;
  sourcePrompt: string;
  promptPreview: string;
  code: string;
  coverImageDataUrl: string;
  revisionId?: string;
  sessionId?: string;
}): FavoriteItem {
  const { itemsDir, instructionsDir, codesDir } = ensureFavoritesDirs();
  const existingNames = new Set(listItemsRaw().map((item) => item.name));
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

export function renameFavoriteById(id: string, requestedName: string): FavoriteItem | undefined {
  const dirs = ensureFavoritesDirs();
  const item = getFavoriteById(id);
  if (!item) {
    return undefined;
  }

  const existingNames = new Set(
    listItemsRaw()
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

export function archiveFavoriteById(id: string): FavoriteItem | undefined {
  const dirs = ensureFavoritesDirs();
  const item = getFavoriteById(id);
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
