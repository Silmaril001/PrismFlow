import { nanoid } from "nanoid";
import {
  type Artifact,
  type ArtifactKind,
  type IdeationAsset,
  type IdeationMessage,
  type Mode,
  type Revision,
  type Session,
} from "./models.js";

export class InMemoryStore {
  private readonly sessions = new Map<string, Session>();
  private readonly revisions = new Map<string, Revision>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly revisionsBySession = new Map<string, string[]>();
  private readonly artifactsByRevision = new Map<string, string[]>();
  private readonly ideationMessagesBySession = new Map<string, IdeationMessage[]>();
  private readonly ideationAssetBySession = new Map<string, IdeationAsset>();

  createSession(mode: Mode, projectId = "default-project"): Session {
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

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  createRevision(input: Omit<Revision, "id" | "createdAt">): Revision {
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

  getRevision(id: string): Revision | undefined {
    return this.revisions.get(id);
  }

  getLatestRevisionBySession(sessionId: string): Revision | undefined {
    const revisionIds = this.revisionsBySession.get(sessionId);
    if (!revisionIds || revisionIds.length === 0) {
      return undefined;
    }

    const latestId = revisionIds[revisionIds.length - 1];
    return latestId ? this.revisions.get(latestId) : undefined;
  }

  createArtifact(input: {
    revisionId: string;
    kind: ArtifactKind;
    content: string;
    meta?: Record<string, unknown>;
  }): Artifact {
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

  getArtifactByRevisionAndKind(revisionId: string, kind: ArtifactKind): Artifact | undefined {
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

  listIdeationMessages(sessionId: string): IdeationMessage[] {
    return [...(this.ideationMessagesBySession.get(sessionId) ?? [])];
  }

  appendIdeationMessage(
    sessionId: string,
    input: Omit<IdeationMessage, "id" | "createdAt">,
  ): IdeationMessage {
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

  getIdeationAsset(sessionId: string): IdeationAsset | undefined {
    return this.ideationAssetBySession.get(sessionId);
  }

  setIdeationAsset(sessionId: string, asset: Omit<IdeationAsset, "id" | "createdAt">): IdeationAsset {
    const stored: IdeationAsset = {
      ...asset,
      id: nanoid(),
      createdAt: new Date().toISOString(),
    };
    this.ideationAssetBySession.set(sessionId, stored);
    return stored;
  }

  resetIdeation(sessionId: string): { asset?: IdeationAsset } {
    const asset = this.ideationAssetBySession.get(sessionId);
    this.ideationMessagesBySession.set(sessionId, []);
    this.ideationAssetBySession.delete(sessionId);
    return { asset };
  }
}
