import type {
  CompileStatus,
  LlmChannel,
  Mode,
  Revision,
  Session,
} from "../models.js";

export interface PipelineRequest {
  session: Session;
  userMessage: string;
  referenceImageDataUrls?: string[];
  previewCompileErrors?: string[];
  modelOverride?: string;
  baseUrlOverride?: string;
  channelOverride?: LlmChannel;
  debugMode?: boolean;
  latestRevision?: Revision;
  latestCode?: string;
}

export interface PipelineExportRequest {
  revision: Revision;
  code: string;
}

export interface PipelineExportResponse {
  filename: string;
  mimeType: string;
  content: string;
}

export interface PipelineResponse {
  code: string;
  llmModel: string;
  requestedModel: string;
  effectiveModel: string;
  fallbackUsed: boolean;
  llmLatencyMs: number;
  compileStatus: CompileStatus;
  compileErrors: string[];
}

export interface Pipeline {
  mode: Mode;
  generate(input: PipelineRequest): Promise<PipelineResponse>;
  iterate(input: PipelineRequest): Promise<PipelineResponse>;
  export(input: PipelineExportRequest): Promise<PipelineExportResponse>;
}

export class PipelineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineUnavailableError";
  }
}
