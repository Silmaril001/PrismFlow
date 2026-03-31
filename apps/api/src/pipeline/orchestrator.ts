import type { LlmChannel, Mode, Session } from "../models.js";
import type { Pipeline, PipelineResponse } from "./types.js";

export class PipelineOrchestrator {
  private readonly pipelines: Map<Mode, Pipeline>;

  constructor(pipelines: Pipeline[]) {
    this.pipelines = new Map(pipelines.map((pipeline) => [pipeline.mode, pipeline]));
  }

  getPipeline(mode: Mode): Pipeline {
    const pipeline = this.pipelines.get(mode);
    if (!pipeline) {
      throw new Error(`No pipeline configured for mode: ${mode}`);
    }
    return pipeline;
  }

  async run(input: {
    session: Session;
    userMessage: string;
    referenceImageDataUrls?: string[];
    previewCompileErrors?: string[];
    modelOverride?: string;
    baseUrlOverride?: string;
    channelOverride?: LlmChannel;
    debugMode?: boolean;
    latestRevisionExists: boolean;
    latestCode?: string;
  }): Promise<PipelineResponse> {
    const pipeline = this.getPipeline(input.session.mode);

    if (input.latestRevisionExists) {
      return pipeline.iterate({
        session: input.session,
        userMessage: input.userMessage,
        referenceImageDataUrls: input.referenceImageDataUrls,
        previewCompileErrors: input.previewCompileErrors,
        modelOverride: input.modelOverride,
        baseUrlOverride: input.baseUrlOverride,
        channelOverride: input.channelOverride,
        debugMode: input.debugMode,
        latestCode: input.latestCode,
      });
    }

    return pipeline.generate({
      session: input.session,
      userMessage: input.userMessage,
      referenceImageDataUrls: input.referenceImageDataUrls,
      previewCompileErrors: input.previewCompileErrors,
      modelOverride: input.modelOverride,
      baseUrlOverride: input.baseUrlOverride,
      channelOverride: input.channelOverride,
      debugMode: input.debugMode,
    });
  }
}
