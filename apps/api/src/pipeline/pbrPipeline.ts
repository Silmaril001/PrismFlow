import {
  type Pipeline,
  type PipelineExportRequest,
  type PipelineExportResponse,
  type PipelineRequest,
  type PipelineResponse,
  PipelineUnavailableError,
} from "./types.js";

export class PbrPipeline implements Pipeline {
  readonly mode = "pbr_texture" as const;

  async generate(_input: PipelineRequest): Promise<PipelineResponse> {
    throw new PipelineUnavailableError(
      "PBR pipeline is not enabled in M1. Shader pipeline is available.",
    );
  }

  async iterate(_input: PipelineRequest): Promise<PipelineResponse> {
    throw new PipelineUnavailableError(
      "PBR pipeline is not enabled in M1. Shader pipeline is available.",
    );
  }

  async export(_input: PipelineExportRequest): Promise<PipelineExportResponse> {
    throw new PipelineUnavailableError(
      "PBR export is not enabled in M1. Shader export is available.",
    );
  }
}
