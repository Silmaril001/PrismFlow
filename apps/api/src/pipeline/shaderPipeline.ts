import { generateShaderWithOpenAI } from "../services/openaiShaderLLM.js";
import { validateShaderBasic } from "../services/shaderValidator.js";
import type {
  Pipeline,
  PipelineExportRequest,
  PipelineExportResponse,
  PipelineRequest,
  PipelineResponse,
} from "./types.js";

export class ShaderPipeline implements Pipeline {
  readonly mode = "shader_glsl" as const;

  async generate(input: PipelineRequest): Promise<PipelineResponse> {
    return this.runGeneration(input, false);
  }

  async iterate(input: PipelineRequest): Promise<PipelineResponse> {
    return this.runGeneration(input, true);
  }

  async export(input: PipelineExportRequest): Promise<PipelineExportResponse> {
    return {
      filename: `shader-${input.revision.id}.glsl`,
      mimeType: "text/plain",
      content: input.code,
    };
  }

  private async runGeneration(
    input: PipelineRequest,
    isIteration: boolean,
  ): Promise<PipelineResponse> {
    let compileErrors: string[] = (input.previewCompileErrors ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 20);
    let code = "";
    let model = "";
    let requestedModel = "";
    let effectiveModel = "";
    let fallbackUsed = false;
    let llmLatencyMs = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generateShaderWithOpenAI({
        userIntent: input.userMessage,
        referenceImageDataUrls: input.referenceImageDataUrls,
        modelOverride: input.modelOverride,
        baseUrlOverride: input.baseUrlOverride,
        channelOverride: input.channelOverride,
        debugMode: input.debugMode,
        previousCode: isIteration ? input.latestCode : undefined,
        compileErrors,
      });

      model = result.model;
      requestedModel = result.requestedModel;
      effectiveModel = result.effectiveModel;
      fallbackUsed = result.fallbackUsed;
      llmLatencyMs = result.latencyMs;
      code = result.code;

      const validation = validateShaderBasic(code);
      if (validation.ok) {
        return {
          code,
          llmModel: model,
          requestedModel,
          effectiveModel,
          fallbackUsed,
          llmLatencyMs,
          compileStatus: "pass",
          compileErrors: [],
        };
      }

      compileErrors = validation.errors;
    }

    return {
      code,
      llmModel: model,
      requestedModel,
      effectiveModel,
      fallbackUsed,
      llmLatencyMs,
      compileStatus: "fail",
      compileErrors,
    };
  }
}
