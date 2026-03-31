import { nanoid } from "nanoid";
import { Pool } from "pg";
import { config } from "./config.js";
import {
  type Artifact,
  type ArtifactKind,
  type CompileStatus,
  type IdeationAsset,
  type IdeationAssetKind,
  type IdeationMessage,
  type IdeationRole,
  type Mode,
  type Revision,
  type Session,
  type SessionStatus,
} from "./models.js";

export interface IdeationAssetPayload {
  kind: IdeationAssetKind;
  mimeType: string;
  dataBase64: string;
}

export interface AppStoreHealthStatus {
  ok: boolean;
  provider: "memory" | "postgres";
  detail?: string;
}

export interface AppStore {
  provider: "memory" | "postgres";
  createSession(mode: Mode, projectId?: string): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  createRevision(input: Omit<Revision, "id" | "createdAt">): Promise<Revision>;
  getRevision(id: string): Promise<Revision | undefined>;
  getLatestRevisionBySession(sessionId: string): Promise<Revision | undefined>;
  createArtifact(input: {
    revisionId: string;
    kind: ArtifactKind;
    content: string;
    meta?: Record<string, unknown>;
  }): Promise<Artifact>;
  getArtifactByRevisionAndKind(revisionId: string, kind: ArtifactKind): Promise<Artifact | undefined>;
  listIdeationMessages(sessionId: string): Promise<IdeationMessage[]>;
  appendIdeationMessage(
    sessionId: string,
    input: Omit<IdeationMessage, "id" | "createdAt">,
  ): Promise<IdeationMessage>;
  getIdeationAsset(sessionId: string): Promise<IdeationAsset | undefined>;
  getIdeationAssetPayload(sessionId: string): Promise<IdeationAssetPayload | undefined>;
  setIdeationAsset(
    sessionId: string,
    asset: Omit<IdeationAsset, "id" | "createdAt"> & IdeationAssetPayload,
  ): Promise<IdeationAsset>;
  resetIdeation(sessionId: string): Promise<{ asset?: IdeationAsset }>;
  healthCheck(): Promise<AppStoreHealthStatus>;
  close(): Promise<void>;
}

type InMemoryAssetEntry = {
  meta: IdeationAsset;
  payload: IdeationAssetPayload;
};

export class InMemoryStore implements AppStore {
  provider: "memory" = "memory";
  private readonly sessions = new Map<string, Session>();
  private readonly revisions = new Map<string, Revision>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly revisionsBySession = new Map<string, string[]>();
  private readonly artifactsByRevision = new Map<string, string[]>();
  private readonly ideationMessagesBySession = new Map<string, IdeationMessage[]>();
  private readonly ideationAssetBySession = new Map<string, InMemoryAssetEntry>();

  async createSession(mode: Mode, projectId = "default-project"): Promise<Session> {
    const session: Session = {
      id: nanoid(),
      mode,
      projectId,
      status: "active",
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.id, session);
    this.revisionsBySession.set(session.id, []);
    this.ideationMessagesBySession.set(session.id, []);
    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async createRevision(input: Omit<Revision, "id" | "createdAt">): Promise<Revision> {
    const revision: Revision = {
      ...input,
      id: nanoid(),
      createdAt: new Date().toISOString(),
    };

    this.revisions.set(revision.id, revision);
    const revisionIds = this.revisionsBySession.get(revision.sessionId);
    if (!revisionIds) {
      this.revisionsBySession.set(revision.sessionId, [revision.id]);
    } else {
      revisionIds.push(revision.id);
    }

    return revision;
  }

  async getRevision(id: string): Promise<Revision | undefined> {
    return this.revisions.get(id);
  }

  async getLatestRevisionBySession(sessionId: string): Promise<Revision | undefined> {
    const revisionIds = this.revisionsBySession.get(sessionId);
    if (!revisionIds || revisionIds.length === 0) {
      return undefined;
    }

    const latestId = revisionIds[revisionIds.length - 1];
    return latestId ? this.revisions.get(latestId) : undefined;
  }

  async createArtifact(input: {
    revisionId: string;
    kind: ArtifactKind;
    content: string;
    meta?: Record<string, unknown>;
  }): Promise<Artifact> {
    const artifact: Artifact = {
      id: nanoid(),
      revisionId: input.revisionId,
      kind: input.kind,
      uri: `inmemory://artifact/${input.revisionId}/${input.kind}`,
      meta: input.meta ?? {},
      content: input.content,
    };

    this.artifacts.set(artifact.id, artifact);
    const artifactIds = this.artifactsByRevision.get(input.revisionId);
    if (!artifactIds) {
      this.artifactsByRevision.set(input.revisionId, [artifact.id]);
    } else {
      artifactIds.push(artifact.id);
    }

    return artifact;
  }

  async getArtifactByRevisionAndKind(
    revisionId: string,
    kind: ArtifactKind,
  ): Promise<Artifact | undefined> {
    const artifactIds = this.artifactsByRevision.get(revisionId);
    if (!artifactIds) {
      return undefined;
    }

    for (const artifactId of artifactIds) {
      const artifact = this.artifacts.get(artifactId);
      if (artifact && artifact.kind === kind) {
        return artifact;
      }
    }

    return undefined;
  }

  async listIdeationMessages(sessionId: string): Promise<IdeationMessage[]> {
    return [...(this.ideationMessagesBySession.get(sessionId) ?? [])];
  }

  async appendIdeationMessage(
    sessionId: string,
    input: Omit<IdeationMessage, "id" | "createdAt">,
  ): Promise<IdeationMessage> {
    const message: IdeationMessage = {
      id: nanoid(),
      role: input.role,
      text: input.text,
      extractedPrompt: input.extractedPrompt,
      createdAt: new Date().toISOString(),
    };
    const list = this.ideationMessagesBySession.get(sessionId) ?? [];
    list.push(message);
    this.ideationMessagesBySession.set(sessionId, list);
    return message;
  }

  async getIdeationAsset(sessionId: string): Promise<IdeationAsset | undefined> {
    return this.ideationAssetBySession.get(sessionId)?.meta;
  }

  async getIdeationAssetPayload(sessionId: string): Promise<IdeationAssetPayload | undefined> {
    return this.ideationAssetBySession.get(sessionId)?.payload;
  }

  async setIdeationAsset(
    sessionId: string,
    asset: Omit<IdeationAsset, "id" | "createdAt"> & IdeationAssetPayload,
  ): Promise<IdeationAsset> {
    const stored: IdeationAsset = {
      id: nanoid(),
      kind: asset.kind,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      createdAt: new Date().toISOString(),
    };
    this.ideationAssetBySession.set(sessionId, {
      meta: stored,
      payload: {
        kind: asset.kind,
        mimeType: asset.mimeType,
        dataBase64: asset.dataBase64,
      },
    });
    return stored;
  }

  async resetIdeation(sessionId: string): Promise<{ asset?: IdeationAsset }> {
    const asset = this.ideationAssetBySession.get(sessionId)?.meta;
    this.ideationMessagesBySession.set(sessionId, []);
    this.ideationAssetBySession.delete(sessionId);
    return { asset };
  }

  async healthCheck(): Promise<AppStoreHealthStatus> {
    return {
      ok: true,
      provider: "memory",
      detail: "Using in-memory app store.",
    };
  }

  async close(): Promise<void> {}
}

interface SessionRow {
  id: string;
  project_id: string;
  mode: string;
  status: string;
  created_at: string | Date;
}

interface RevisionRow {
  id: string;
  session_id: string;
  parent_revision_id: string | null;
  prompt: string;
  llm_model: string;
  requested_model: string;
  effective_model: string;
  fallback_used: boolean;
  llm_latency_ms: number;
  compile_status: string;
  compile_errors: unknown;
  created_at: string | Date;
}

interface ArtifactRow {
  id: string;
  revision_id: string;
  kind: string;
  uri: string;
  meta: unknown;
  content: string;
}

interface IdeationMessageRow {
  id: string;
  session_id: string;
  role: string;
  text: string;
  extracted_prompt: string | null;
  created_at: string | Date;
}

interface IdeationAssetRow {
  id: string;
  session_id: string;
  kind: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  data_base64: string;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode as Mode,
    status: row.status as SessionStatus,
    createdAt: toIso(row.created_at),
  };
}

function mapRevisionRow(row: RevisionRow): Revision {
  const compileErrorsRaw = Array.isArray(row.compile_errors) ? row.compile_errors : [];
  const compileErrors = compileErrorsRaw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item);

  return {
    id: row.id,
    sessionId: row.session_id,
    parentRevisionId: row.parent_revision_id,
    prompt: row.prompt,
    llmModel: row.llm_model,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    fallbackUsed: row.fallback_used,
    llmLatencyMs: row.llm_latency_ms,
    compileStatus: row.compile_status as CompileStatus,
    compileErrors,
    createdAt: toIso(row.created_at),
  };
}

function mapArtifactRow(row: ArtifactRow): Artifact {
  const meta =
    row.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>) : {};
  return {
    id: row.id,
    revisionId: row.revision_id,
    kind: row.kind as ArtifactKind,
    uri: row.uri,
    meta,
    content: row.content,
  };
}

function mapIdeationMessageRow(row: IdeationMessageRow): IdeationMessage {
  return {
    id: row.id,
    role: row.role as IdeationRole,
    text: row.text,
    extractedPrompt: row.extracted_prompt ?? undefined,
    createdAt: toIso(row.created_at),
  };
}

function mapIdeationAssetRow(row: IdeationAssetRow): IdeationAsset {
  return {
    id: row.id,
    kind: row.kind as IdeationAssetKind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    bytes: row.bytes,
    createdAt: toIso(row.created_at),
  };
}

class PostgresStore implements AppStore {
  provider: "postgres" = "postgres";
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    if (!config.postgresAutoMigrate) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_revision_id TEXT,
        prompt TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        effective_model TEXT NOT NULL,
        fallback_used BOOLEAN NOT NULL,
        llm_latency_ms INTEGER NOT NULL,
        compile_status TEXT NOT NULL,
        compile_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_session_created_at
        ON revisions(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_revision_kind
        ON artifacts(revision_id, kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS ideation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        extracted_prompt TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ideation_messages_session_created_at
        ON ideation_messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS ideation_assets (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        id TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        data_base64 TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async createSession(mode: Mode, projectId = "default-project"): Promise<Session> {
    const session: Session = {
      id: nanoid(),
      mode,
      projectId,
      status: "active",
      createdAt: new Date().toISOString(),
    };

    await this.pool.query(
      `
        INSERT INTO sessions (id, project_id, mode, status, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [session.id, session.projectId, session.mode, session.status, session.createdAt],
    );

    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const result = await this.pool.query<SessionRow>(
      `
        SELECT id, project_id, mode, status, created_at
        FROM sessions
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    if (!result.rowCount) {
      return undefined;
    }
    return mapSessionRow(result.rows[0]!);
  }

  async createRevision(input: Omit<Revision, "id" | "createdAt">): Promise<Revision> {
    const revision: Revision = {
      ...input,
      id: nanoid(),
      createdAt: new Date().toISOString(),
    };

    await this.pool.query(
      `
        INSERT INTO revisions (
          id, session_id, parent_revision_id, prompt, llm_model, requested_model,
          effective_model, fallback_used, llm_latency_ms, compile_status, compile_errors, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11::jsonb, $12
        )
      `,
      [
        revision.id,
        revision.sessionId,
        revision.parentRevisionId,
        revision.prompt,
        revision.llmModel,
        revision.requestedModel,
        revision.effectiveModel,
        revision.fallbackUsed,
        revision.llmLatencyMs,
        revision.compileStatus,
        JSON.stringify(revision.compileErrors),
        revision.createdAt,
      ],
    );

    return revision;
  }

  async getRevision(id: string): Promise<Revision | undefined> {
    const result = await this.pool.query<RevisionRow>(
      `
        SELECT id, session_id, parent_revision_id, prompt, llm_model, requested_model,
               effective_model, fallback_used, llm_latency_ms, compile_status, compile_errors, created_at
        FROM revisions
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    if (!result.rowCount) {
      return undefined;
    }
    return mapRevisionRow(result.rows[0]!);
  }

  async getLatestRevisionBySession(sessionId: string): Promise<Revision | undefined> {
    const result = await this.pool.query<RevisionRow>(
      `
        SELECT id, session_id, parent_revision_id, prompt, llm_model, requested_model,
               effective_model, fallback_used, llm_latency_ms, compile_status, compile_errors, created_at
        FROM revisions
        WHERE session_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [sessionId],
    );
    if (!result.rowCount) {
      return undefined;
    }
    return mapRevisionRow(result.rows[0]!);
  }

  async createArtifact(input: {
    revisionId: string;
    kind: ArtifactKind;
    content: string;
    meta?: Record<string, unknown>;
  }): Promise<Artifact> {
    const artifact: Artifact = {
      id: nanoid(),
      revisionId: input.revisionId,
      kind: input.kind,
      uri: `postgres://artifact/${input.revisionId}/${input.kind}`,
      meta: input.meta ?? {},
      content: input.content,
    };

    await this.pool.query(
      `
        INSERT INTO artifacts (id, revision_id, kind, uri, meta, content)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [
        artifact.id,
        artifact.revisionId,
        artifact.kind,
        artifact.uri,
        JSON.stringify(artifact.meta),
        artifact.content,
      ],
    );

    return artifact;
  }

  async getArtifactByRevisionAndKind(
    revisionId: string,
    kind: ArtifactKind,
  ): Promise<Artifact | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `
        SELECT id, revision_id, kind, uri, meta, content
        FROM artifacts
        WHERE revision_id = $1 AND kind = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [revisionId, kind],
    );
    if (!result.rowCount) {
      return undefined;
    }
    return mapArtifactRow(result.rows[0]!);
  }

  async listIdeationMessages(sessionId: string): Promise<IdeationMessage[]> {
    const result = await this.pool.query<IdeationMessageRow>(
      `
        SELECT id, session_id, role, text, extracted_prompt, created_at
        FROM ideation_messages
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [sessionId],
    );
    return result.rows.map((row) => mapIdeationMessageRow(row));
  }

  async appendIdeationMessage(
    sessionId: string,
    input: Omit<IdeationMessage, "id" | "createdAt">,
  ): Promise<IdeationMessage> {
    const message: IdeationMessage = {
      id: nanoid(),
      role: input.role,
      text: input.text,
      extractedPrompt: input.extractedPrompt,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query(
      `
        INSERT INTO ideation_messages (id, session_id, role, text, extracted_prompt, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        message.id,
        sessionId,
        message.role,
        message.text,
        message.extractedPrompt ?? null,
        message.createdAt,
      ],
    );
    return message;
  }

  async getIdeationAsset(sessionId: string): Promise<IdeationAsset | undefined> {
    const result = await this.pool.query<IdeationAssetRow>(
      `
        SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64, created_at
        FROM ideation_assets
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId],
    );
    if (!result.rowCount) {
      return undefined;
    }
    return mapIdeationAssetRow(result.rows[0]!);
  }

  async getIdeationAssetPayload(sessionId: string): Promise<IdeationAssetPayload | undefined> {
    const result = await this.pool.query<IdeationAssetRow>(
      `
        SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64, created_at
        FROM ideation_assets
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId],
    );
    if (!result.rowCount) {
      return undefined;
    }
    const row = result.rows[0]!;
    return {
      kind: row.kind as IdeationAssetKind,
      mimeType: row.mime_type,
      dataBase64: row.data_base64,
    };
  }

  async setIdeationAsset(
    sessionId: string,
    asset: Omit<IdeationAsset, "id" | "createdAt"> & IdeationAssetPayload,
  ): Promise<IdeationAsset> {
    const stored: IdeationAsset = {
      id: nanoid(),
      kind: asset.kind,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      createdAt: new Date().toISOString(),
    };

    await this.pool.query(
      `
        INSERT INTO ideation_assets (
          session_id, id, kind, file_name, mime_type, bytes, data_base64, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        ON CONFLICT (session_id) DO UPDATE SET
          id = EXCLUDED.id,
          kind = EXCLUDED.kind,
          file_name = EXCLUDED.file_name,
          mime_type = EXCLUDED.mime_type,
          bytes = EXCLUDED.bytes,
          data_base64 = EXCLUDED.data_base64,
          created_at = EXCLUDED.created_at
      `,
      [
        sessionId,
        stored.id,
        stored.kind,
        stored.fileName,
        stored.mimeType,
        stored.bytes,
        asset.dataBase64,
        stored.createdAt,
      ],
    );

    return stored;
  }

  async resetIdeation(sessionId: string): Promise<{ asset?: IdeationAsset }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const assetResult = await client.query<IdeationAssetRow>(
        `
          SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64, created_at
          FROM ideation_assets
          WHERE session_id = $1
          LIMIT 1
        `,
        [sessionId],
      );

      await client.query(`DELETE FROM ideation_messages WHERE session_id = $1`, [sessionId]);
      await client.query(`DELETE FROM ideation_assets WHERE session_id = $1`, [sessionId]);
      await client.query("COMMIT");

      return {
        asset: assetResult.rowCount ? mapIdeationAssetRow(assetResult.rows[0]!) : undefined,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<AppStoreHealthStatus> {
    try {
      await this.pool.query("SELECT 1");
      return {
        ok: true,
        provider: "postgres",
        detail: "Connected to PostgreSQL app store.",
      };
    } catch (error) {
      return {
        ok: false,
        provider: "postgres",
        detail: error instanceof Error ? error.message : "PostgreSQL app store health check failed.",
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createAppStoreFromConfig(): Promise<AppStore> {
  if (config.appStoreProvider !== "postgres") {
    return new InMemoryStore();
  }

  if (!config.postgresUrl) {
    throw new Error("APP_STORE_PROVIDER=postgres requires POSTGRES_URL.");
  }

  const pool = new Pool({
    connectionString: config.postgresUrl,
    ssl: config.postgresSsl ? { rejectUnauthorized: false } : undefined,
  });
  const store = new PostgresStore(pool);
  await store.init();
  return store;
}
