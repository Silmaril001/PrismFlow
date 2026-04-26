import { nanoid } from "nanoid";
import { Pool } from "pg";
import { config } from "./config.js";
import {
  createObjectStorageProviderFromConfig,
  type ObjectStorageProvider,
} from "./services/objectStorage.js";
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

export interface GenerationLogSummary {
  revisionId: string;
  sessionId: string;
  mode: Mode;
  promptPreview: string;
  requestedModel: string;
  effectiveModel: string;
  compileStatus: CompileStatus;
  llmLatencyMs: number;
  createdAt: string;
}

export interface GenerationLogDetail extends GenerationLogSummary {
  parentRevisionId: string | null;
  prompt: string;
  compileErrors: string[];
  code: string;
}

export interface AnalyticsEventInput {
  method: string;
  path: string;
  routeKey: string;
  statusCode: number;
  durationMs: number;
  sessionId?: string;
  clientKey: string;
  createdAt?: string;
}

export type AnalyticsBucket = "hour" | "day";

export interface AnalyticsOverview {
  from: string;
  to: string;
  totalRequests: number;
  generationRequests: number;
  generationSuccesses: number;
  uniqueClients: number;
  successResponses: number;
  clientErrors: number;
  serverErrors: number;
  avgDurationMs: number;
}

export interface AnalyticsTimeseriesPoint {
  bucketStart: string;
  totalRequests: number;
  generationRequests: number;
  generationSuccesses: number;
  uniqueClients: number;
  avgDurationMs: number;
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
  listGenerationLogs(params: {
    limit: number;
    offset: number;
  }): Promise<{ total: number; items: GenerationLogSummary[] }>;
  getGenerationLogDetail(revisionId: string): Promise<GenerationLogDetail | undefined>;
  recordAnalyticsEvent(input: AnalyticsEventInput): Promise<void>;
  getAnalyticsOverview(params: { from: string; to: string }): Promise<AnalyticsOverview>;
  getAnalyticsTimeseries(params: {
    from: string;
    to: string;
    bucket: AnalyticsBucket;
  }): Promise<AnalyticsTimeseriesPoint[]>;
  healthCheck(): Promise<AppStoreHealthStatus>;
  close(): Promise<void>;
}

type InMemoryAssetEntry = {
  meta: IdeationAsset;
  payload: IdeationAssetPayload;
};

interface InMemoryAnalyticsEvent {
  method: string;
  path: string;
  routeKey: string;
  statusCode: number;
  durationMs: number;
  sessionId?: string;
  clientKey: string;
  createdAt: string;
}

function buildPromptPreview(prompt: string, maxLength = 140): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function floorDateToBucket(date: Date, bucket: AnalyticsBucket): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (bucket === "day") {
    d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

export class InMemoryStore implements AppStore {
  provider: "memory" = "memory";
  private readonly sessions = new Map<string, Session>();
  private readonly revisions = new Map<string, Revision>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly revisionsBySession = new Map<string, string[]>();
  private readonly artifactsByRevision = new Map<string, string[]>();
  private readonly ideationMessagesBySession = new Map<string, IdeationMessage[]>();
  private readonly ideationAssetBySession = new Map<string, InMemoryAssetEntry>();
  private readonly analyticsEvents: InMemoryAnalyticsEvent[] = [];

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

  async listGenerationLogs(params: {
    limit: number;
    offset: number;
  }): Promise<{ total: number; items: GenerationLogSummary[] }> {
    const revisions = [...this.revisions.values()]
      .filter((revision) => {
        const artifactIds = this.artifactsByRevision.get(revision.id);
        if (!artifactIds || artifactIds.length === 0) {
          return false;
        }
        return artifactIds.some((artifactId) => this.artifacts.get(artifactId)?.kind === "glsl_fragment");
      })
      .sort((a, b) => {
        const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return b.id.localeCompare(a.id);
      });

    const total = revisions.length;
    const items = revisions.slice(params.offset, params.offset + params.limit).map((revision) => {
      const session = this.sessions.get(revision.sessionId);
      return {
        revisionId: revision.id,
        sessionId: revision.sessionId,
        mode: session?.mode ?? "shader_glsl",
        promptPreview: buildPromptPreview(revision.prompt),
        requestedModel: revision.requestedModel,
        effectiveModel: revision.effectiveModel,
        compileStatus: revision.compileStatus,
        llmLatencyMs: revision.llmLatencyMs,
        createdAt: revision.createdAt,
      } satisfies GenerationLogSummary;
    });

    return { total, items };
  }

  async getGenerationLogDetail(revisionId: string): Promise<GenerationLogDetail | undefined> {
    const revision = this.revisions.get(revisionId);
    if (!revision) {
      return undefined;
    }
    const session = this.sessions.get(revision.sessionId);
    const artifact = await this.getArtifactByRevisionAndKind(revision.id, "glsl_fragment");
    if (!artifact) {
      return undefined;
    }
    return {
      revisionId: revision.id,
      sessionId: revision.sessionId,
      mode: session?.mode ?? "shader_glsl",
      parentRevisionId: revision.parentRevisionId,
      promptPreview: buildPromptPreview(revision.prompt),
      prompt: revision.prompt,
      requestedModel: revision.requestedModel,
      effectiveModel: revision.effectiveModel,
      compileStatus: revision.compileStatus,
      compileErrors: revision.compileErrors,
      llmLatencyMs: revision.llmLatencyMs,
      createdAt: revision.createdAt,
      code: artifact.content,
    };
  }

  async recordAnalyticsEvent(input: AnalyticsEventInput): Promise<void> {
    this.analyticsEvents.push({
      method: input.method,
      path: input.path,
      routeKey: input.routeKey,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      sessionId: input.sessionId,
      clientKey: input.clientKey,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    if (this.analyticsEvents.length > 100_000) {
      this.analyticsEvents.splice(0, this.analyticsEvents.length - 100_000);
    }
  }

  async getAnalyticsOverview(params: { from: string; to: string }): Promise<AnalyticsOverview> {
    const fromTs = new Date(params.from).getTime();
    const toTs = new Date(params.to).getTime();
    const scoped = this.analyticsEvents.filter((event) => {
      const ts = new Date(event.createdAt).getTime();
      return ts >= fromTs && ts < toTs;
    });

    const totalRequests = scoped.length;
    const generationScoped = scoped.filter(
      (event) => event.routeKey === "/v1/sessions/:id/messages",
    );
    const generationRequests = generationScoped.length;
    const generationSuccesses = generationScoped.filter(
      (event) => event.statusCode >= 200 && event.statusCode < 300,
    ).length;
    const uniqueClients = new Set(scoped.map((event) => event.clientKey)).size;
    const successResponses = scoped.filter(
      (event) => event.statusCode >= 200 && event.statusCode < 300,
    ).length;
    const clientErrors = scoped.filter(
      (event) => event.statusCode >= 400 && event.statusCode < 500,
    ).length;
    const serverErrors = scoped.filter((event) => event.statusCode >= 500).length;
    const avgDurationMs =
      totalRequests > 0
        ? Math.round(scoped.reduce((sum, event) => sum + event.durationMs, 0) / totalRequests)
        : 0;

    return {
      from: new Date(fromTs).toISOString(),
      to: new Date(toTs).toISOString(),
      totalRequests,
      generationRequests,
      generationSuccesses,
      uniqueClients,
      successResponses,
      clientErrors,
      serverErrors,
      avgDurationMs,
    };
  }

  async getAnalyticsTimeseries(params: {
    from: string;
    to: string;
    bucket: AnalyticsBucket;
  }): Promise<AnalyticsTimeseriesPoint[]> {
    const fromTs = new Date(params.from).getTime();
    const toTs = new Date(params.to).getTime();
    const scoped = this.analyticsEvents.filter((event) => {
      const ts = new Date(event.createdAt).getTime();
      return ts >= fromTs && ts < toTs;
    });

    const bucketMap = new Map<
      string,
      {
        totalRequests: number;
        generationRequests: number;
        generationSuccesses: number;
        uniqueClients: Set<string>;
        durationSum: number;
      }
    >();

    for (const event of scoped) {
      const bucketStart = floorDateToBucket(new Date(event.createdAt), params.bucket).toISOString();
      const target = bucketMap.get(bucketStart) ?? {
        totalRequests: 0,
        generationRequests: 0,
        generationSuccesses: 0,
        uniqueClients: new Set<string>(),
        durationSum: 0,
      };
      target.totalRequests += 1;
      if (event.routeKey === "/v1/sessions/:id/messages") {
        target.generationRequests += 1;
        if (event.statusCode >= 200 && event.statusCode < 300) {
          target.generationSuccesses += 1;
        }
      }
      target.uniqueClients.add(event.clientKey);
      target.durationSum += event.durationMs;
      bucketMap.set(bucketStart, target);
    }

    return [...bucketMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucketStart, value]) => ({
        bucketStart,
        totalRequests: value.totalRequests,
        generationRequests: value.generationRequests,
        generationSuccesses: value.generationSuccesses,
        uniqueClients: value.uniqueClients.size,
        avgDurationMs:
          value.totalRequests > 0 ? Math.round(value.durationSum / value.totalRequests) : 0,
      }));
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
  data_base64: string | null;
  storage_provider: string | null;
  object_key: string | null;
  object_url: string | null;
  created_at: string | Date;
}

interface GenerationLogSummaryRow extends RevisionRow {
  mode: string;
}

interface GenerationLogDetailRow extends RevisionRow {
  mode: string;
  code: string;
}

interface AnalyticsOverviewRow {
  total_requests: string;
  generation_requests: string;
  generation_successes: string;
  unique_clients: string;
  success_responses: string;
  client_errors: string;
  server_errors: string;
  avg_duration_ms: number | null;
}

interface AnalyticsTimeseriesRow {
  bucket_start: string | Date;
  total_requests: string;
  generation_requests: string;
  generation_successes: string;
  unique_clients: string;
  avg_duration_ms: number | null;
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
  private readonly objectStorage: ObjectStorageProvider;

  constructor(pool: Pool, objectStorage: ObjectStorageProvider) {
    this.pool = pool;
    this.objectStorage = objectStorage;
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
      CREATE INDEX IF NOT EXISTS idx_revisions_created_at
        ON revisions(created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS analytics_events (
        id BIGSERIAL PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        route_key TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        session_id TEXT,
        client_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
        ON analytics_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_events_route_created
        ON analytics_events(route_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_events_client_created
        ON analytics_events(client_key, created_at DESC);

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
        data_base64 TEXT,
        storage_provider TEXT,
        object_key TEXT,
        object_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE ideation_assets
        ADD COLUMN IF NOT EXISTS storage_provider TEXT;
      ALTER TABLE ideation_assets
        ADD COLUMN IF NOT EXISTS object_key TEXT;
      ALTER TABLE ideation_assets
        ADD COLUMN IF NOT EXISTS object_url TEXT;
      ALTER TABLE ideation_assets
        ALTER COLUMN data_base64 DROP NOT NULL;
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
        SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64,
               storage_provider, object_key, object_url, created_at
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
        SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64,
               storage_provider, object_key, object_url, created_at
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
    if (row.data_base64 && row.data_base64.length > 0) {
      return {
        kind: row.kind as IdeationAssetKind,
        mimeType: row.mime_type,
        dataBase64: row.data_base64,
      };
    }

    if (row.storage_provider === "s3" && row.object_key) {
      if (this.objectStorage.provider !== "s3") {
        throw new Error(
          "Ideation asset payload is stored in object storage, but OBJECT_STORAGE_PROVIDER is not s3.",
        );
      }

      const downloaded = await this.objectStorage.readObjectAsBase64({
        key: row.object_key,
      });
      return {
        kind: row.kind as IdeationAssetKind,
        mimeType: downloaded.contentType ?? row.mime_type,
        dataBase64: downloaded.base64,
      };
    }

    if (row.object_key) {
      throw new Error("Ideation asset payload is missing because object storage is unavailable.");
    }

    return undefined;
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

    let dataBase64: string | null = asset.dataBase64;
    let storageProvider: string | null = null;
    let objectKey: string | null = null;
    let objectUrl: string | null = null;
    if (this.objectStorage.provider === "s3") {
      const uploaded = await this.objectStorage.uploadBase64({
        base64: asset.dataBase64,
        contentType: asset.mimeType,
        keyPrefix: `${config.s3KeyPrefix}/ideation/assets`,
        fileName: asset.fileName,
      });
      dataBase64 = null;
      storageProvider = "s3";
      objectKey = uploaded.key;
      objectUrl = uploaded.publicUrl;
    }

    await this.pool.query(
      `
        INSERT INTO ideation_assets (
          session_id, id, kind, file_name, mime_type, bytes, data_base64,
          storage_provider, object_key, object_url, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11
        )
        ON CONFLICT (session_id) DO UPDATE SET
          id = EXCLUDED.id,
          kind = EXCLUDED.kind,
          file_name = EXCLUDED.file_name,
          mime_type = EXCLUDED.mime_type,
          bytes = EXCLUDED.bytes,
          data_base64 = EXCLUDED.data_base64,
          storage_provider = EXCLUDED.storage_provider,
          object_key = EXCLUDED.object_key,
          object_url = EXCLUDED.object_url,
          created_at = EXCLUDED.created_at
      `,
      [
        sessionId,
        stored.id,
        stored.kind,
        stored.fileName,
        stored.mimeType,
        stored.bytes,
        dataBase64,
        storageProvider,
        objectKey,
        objectUrl,
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
          SELECT id, session_id, kind, file_name, mime_type, bytes, data_base64,
                 storage_provider, object_key, object_url, created_at
          FROM ideation_assets
          WHERE session_id = $1
          LIMIT 1
        `,
        [sessionId],
      );
      const existingAsset = assetResult.rowCount ? assetResult.rows[0]! : undefined;
      const objectKeyToDelete = existingAsset?.object_key;

      await client.query(`DELETE FROM ideation_messages WHERE session_id = $1`, [sessionId]);
      await client.query(`DELETE FROM ideation_assets WHERE session_id = $1`, [sessionId]);
      await client.query("COMMIT");

      if (objectKeyToDelete && this.objectStorage.provider === "s3") {
        try {
          await this.objectStorage.deleteObject({ key: objectKeyToDelete });
        } catch {
          // Best-effort cleanup; database state is already consistent.
        }
      }

      return {
        asset: existingAsset ? mapIdeationAssetRow(existingAsset) : undefined,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listGenerationLogs(params: {
    limit: number;
    offset: number;
  }): Promise<{ total: number; items: GenerationLogSummary[] }> {
    const [countResult, rowsResult] = await Promise.all([
      this.pool.query<{ total: string }>(
        `
          SELECT COUNT(*)::bigint AS total
          FROM revisions r
          WHERE EXISTS (
            SELECT 1
            FROM artifacts a
            WHERE a.revision_id = r.id
              AND a.kind = 'glsl_fragment'
          )
        `,
      ),
      this.pool.query<GenerationLogSummaryRow>(
        `
          SELECT r.id, r.session_id, r.parent_revision_id, r.prompt, r.llm_model,
                 r.requested_model, r.effective_model, r.fallback_used, r.llm_latency_ms,
                 r.compile_status, r.compile_errors, r.created_at,
                 s.mode
          FROM revisions r
          JOIN sessions s ON s.id = r.session_id
          WHERE EXISTS (
            SELECT 1
            FROM artifacts a
            WHERE a.revision_id = r.id
              AND a.kind = 'glsl_fragment'
          )
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $1 OFFSET $2
        `,
        [params.limit, params.offset],
      ),
    ]);

    const total = Number.parseInt(countResult.rows[0]?.total ?? "0", 10) || 0;
    const items = rowsResult.rows.map((row) => {
      const revision = mapRevisionRow(row);
      return {
        revisionId: revision.id,
        sessionId: revision.sessionId,
        mode: row.mode as Mode,
        promptPreview: buildPromptPreview(revision.prompt),
        requestedModel: revision.requestedModel,
        effectiveModel: revision.effectiveModel,
        compileStatus: revision.compileStatus,
        llmLatencyMs: revision.llmLatencyMs,
        createdAt: revision.createdAt,
      } satisfies GenerationLogSummary;
    });

    return { total, items };
  }

  async getGenerationLogDetail(revisionId: string): Promise<GenerationLogDetail | undefined> {
    const result = await this.pool.query<GenerationLogDetailRow>(
      `
        SELECT r.id, r.session_id, r.parent_revision_id, r.prompt, r.llm_model,
               r.requested_model, r.effective_model, r.fallback_used, r.llm_latency_ms,
               r.compile_status, r.compile_errors, r.created_at,
               s.mode,
               a.content AS code
        FROM revisions r
        JOIN sessions s ON s.id = r.session_id
        JOIN LATERAL (
          SELECT content
          FROM artifacts a
          WHERE a.revision_id = r.id
            AND a.kind = 'glsl_fragment'
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        ) a ON TRUE
        WHERE r.id = $1
        LIMIT 1
      `,
      [revisionId],
    );

    if (!result.rowCount) {
      return undefined;
    }
    const row = result.rows[0]!;
    const revision = mapRevisionRow(row);
    return {
      revisionId: revision.id,
      sessionId: revision.sessionId,
      mode: row.mode as Mode,
      parentRevisionId: revision.parentRevisionId,
      promptPreview: buildPromptPreview(revision.prompt),
      prompt: revision.prompt,
      requestedModel: revision.requestedModel,
      effectiveModel: revision.effectiveModel,
      compileStatus: revision.compileStatus,
      compileErrors: revision.compileErrors,
      llmLatencyMs: revision.llmLatencyMs,
      createdAt: revision.createdAt,
      code: row.code,
    };
  }

  async recordAnalyticsEvent(input: AnalyticsEventInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO analytics_events (
          method, path, route_key, status_code, duration_ms,
          session_id, client_key, created_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8
        )
      `,
      [
        input.method,
        input.path,
        input.routeKey,
        input.statusCode,
        input.durationMs,
        input.sessionId ?? null,
        input.clientKey,
        input.createdAt ?? new Date().toISOString(),
      ],
    );
  }

  async getAnalyticsOverview(params: { from: string; to: string }): Promise<AnalyticsOverview> {
    const result = await this.pool.query<AnalyticsOverviewRow>(
      `
        SELECT
          COUNT(*)::bigint AS total_requests,
          COUNT(*) FILTER (
            WHERE route_key = '/v1/sessions/:id/messages'
          )::bigint AS generation_requests,
          COUNT(*) FILTER (
            WHERE route_key = '/v1/sessions/:id/messages'
              AND status_code BETWEEN 200 AND 299
          )::bigint AS generation_successes,
          COUNT(DISTINCT client_key)::bigint AS unique_clients,
          COUNT(*) FILTER (
            WHERE status_code BETWEEN 200 AND 299
          )::bigint AS success_responses,
          COUNT(*) FILTER (
            WHERE status_code BETWEEN 400 AND 499
          )::bigint AS client_errors,
          COUNT(*) FILTER (
            WHERE status_code >= 500
          )::bigint AS server_errors,
          ROUND(AVG(duration_ms))::int AS avg_duration_ms
        FROM analytics_events
        WHERE created_at >= $1::timestamptz
          AND created_at < $2::timestamptz
      `,
      [params.from, params.to],
    );

    const row = result.rows[0];
    return {
      from: new Date(params.from).toISOString(),
      to: new Date(params.to).toISOString(),
      totalRequests: Number.parseInt(row?.total_requests ?? "0", 10) || 0,
      generationRequests: Number.parseInt(row?.generation_requests ?? "0", 10) || 0,
      generationSuccesses: Number.parseInt(row?.generation_successes ?? "0", 10) || 0,
      uniqueClients: Number.parseInt(row?.unique_clients ?? "0", 10) || 0,
      successResponses: Number.parseInt(row?.success_responses ?? "0", 10) || 0,
      clientErrors: Number.parseInt(row?.client_errors ?? "0", 10) || 0,
      serverErrors: Number.parseInt(row?.server_errors ?? "0", 10) || 0,
      avgDurationMs: row?.avg_duration_ms ?? 0,
    };
  }

  async getAnalyticsTimeseries(params: {
    from: string;
    to: string;
    bucket: AnalyticsBucket;
  }): Promise<AnalyticsTimeseriesPoint[]> {
    const bucketSql = params.bucket === "day" ? "day" : "hour";
    const result = await this.pool.query<AnalyticsTimeseriesRow>(
      `
        SELECT
          date_trunc('${bucketSql}', created_at) AS bucket_start,
          COUNT(*)::bigint AS total_requests,
          COUNT(*) FILTER (
            WHERE route_key = '/v1/sessions/:id/messages'
          )::bigint AS generation_requests,
          COUNT(*) FILTER (
            WHERE route_key = '/v1/sessions/:id/messages'
              AND status_code BETWEEN 200 AND 299
          )::bigint AS generation_successes,
          COUNT(DISTINCT client_key)::bigint AS unique_clients,
          ROUND(AVG(duration_ms))::int AS avg_duration_ms
        FROM analytics_events
        WHERE created_at >= $1::timestamptz
          AND created_at < $2::timestamptz
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      [params.from, params.to],
    );

    return result.rows.map((row) => ({
      bucketStart: toIso(row.bucket_start),
      totalRequests: Number.parseInt(row.total_requests, 10) || 0,
      generationRequests: Number.parseInt(row.generation_requests, 10) || 0,
      generationSuccesses: Number.parseInt(row.generation_successes, 10) || 0,
      uniqueClients: Number.parseInt(row.unique_clients, 10) || 0,
      avgDurationMs: row.avg_duration_ms ?? 0,
    }));
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
  const objectStorage = createObjectStorageProviderFromConfig();
  const store = new PostgresStore(pool, objectStorage);
  await store.init();
  return store;
}
