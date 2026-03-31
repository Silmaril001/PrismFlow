export type Mode = "shader_glsl" | "pbr_texture";
export type LlmChannel = "rightcode" | "openrouter";

export type SessionStatus = "active" | "archived";
export type CompileStatus = "pass" | "fail" | "unchecked";
export type IdeationRole = "user" | "assistant";
export type IdeationAssetKind = "image" | "video";

export interface Project {
  id: string;
  name: string;
  ownerId: string;
}

export interface Session {
  id: string;
  projectId: string;
  mode: Mode;
  status: SessionStatus;
  createdAt: string;
}

export interface Revision {
  id: string;
  sessionId: string;
  parentRevisionId: string | null;
  prompt: string;
  llmModel: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  llmLatencyMs: number;
  compileStatus: CompileStatus;
  compileErrors: string[];
  createdAt: string;
}

export interface IdeationMessage {
  id: string;
  role: IdeationRole;
  text: string;
  extractedPrompt?: string;
  createdAt: string;
}

export interface IdeationAsset {
  id: string;
  kind: IdeationAssetKind;
  fileName: string;
  mimeType: string;
  bytes: number;
  storagePath: string;
  createdAt: string;
}

export type ArtifactKind =
  | "glsl_fragment"
  | "albedo"
  | "normal"
  | "roughness"
  | "orm_zip";

export interface Artifact {
  id: string;
  revisionId: string;
  kind: ArtifactKind;
  uri: string;
  meta: Record<string, unknown>;
  content: string;
}
