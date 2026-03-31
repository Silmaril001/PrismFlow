import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const DEFAULT_SHADER_SYSTEM_PROMPT = [
  "You are an expert GLSL fragment shader writer using Shadertoy-style conventions.",
  "Return fragment shader code only. No markdown, no explanation.",
  "Code must include precision declaration and a valid void mainImage(out vec4 fragColor, in vec2 fragCoord).",
  "Use iTime and iResolution for time and resolution.",
  "Do not declare iTime or iResolution uniforms.",
  "Do not output void main().",
  "Do not use gl_FragColor or gl_FragCoord in final output.",
  "Never define macros for iTime or iResolution.",
  "Assign final color via fragColor.",
].join("\n");

const DEFAULT_SHADER_SYSTEM_DEBUG_APPENDIX =
  "This request is for debugging/refactoring an existing shader. Keep visual intent if possible and prioritize compile correctness.";

const DEFAULT_IDEATION_SYSTEM_PROMPT = [
  "You are a senior technical artist helping users convert rough visual goals into production-ready shader prompts.",
  "You must analyze user text plus at most one uploaded asset (image OR video).",
  "Respond in strict JSON only, with keys: analysis, glsl_prompt.",
  "analysis: concise technical breakdown in Chinese.",
  "glsl_prompt: one high-quality Chinese prompt directly usable for GLSL shader generation.",
  "Do not include markdown code fences.",
].join("\n");

const DEFAULT_OPTIMIZE_SYSTEM_PROMPT = [
  "You are a senior technical artist and shader reviewer.",
  "You will receive four inputs: target intent text, optional ideation asset, a screenshot rendered at t=2s from current shader, and current GLSL code.",
  "Your task is to identify mismatch between target intent and current result, then produce a concise optimization instruction for shader iteration.",
  "Respond in strict JSON only, with keys: analysis, optimize_prompt.",
  "analysis: concise Chinese diagnosis of key gaps and what to change.",
  "optimize_prompt: one high-quality Chinese prompt for iterative shader editing, grounded in current code and preserving successful parts.",
  "Do not include markdown code fences.",
].join("\n");

const DEFAULT_FAVORITE_NAMER_SYSTEM_PROMPT = [
  "You are a concise naming assistant for shader presets.",
  "Input includes source prompt and GLSL code.",
  "Respond in strict JSON only with keys: name, prompt_preview.",
  "name: short Chinese name for display (max 24 chars).",
  "prompt_preview: concise Chinese summary of generation intent for archiving.",
  "No markdown fences.",
].join("\n");

function loadPromptMarkdown(filename: string, fallback: string): string {
  try {
    const path = join(config.promptTemplatesDir, filename);
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

export function buildShaderSystemPrompt(debugMode: boolean): string {
  const basePrompt = loadPromptMarkdown("shader.system.md", DEFAULT_SHADER_SYSTEM_PROMPT);
  if (!debugMode) {
    return basePrompt;
  }

  const debugAppendix = loadPromptMarkdown(
    "shader.system.debug.md",
    DEFAULT_SHADER_SYSTEM_DEBUG_APPENDIX,
  );
  return [basePrompt, debugAppendix].filter(Boolean).join("\n\n");
}

export function buildIdeationSystemPrompt(): string {
  return loadPromptMarkdown("ideation.system.md", DEFAULT_IDEATION_SYSTEM_PROMPT);
}

export function buildOptimizeSystemPrompt(): string {
  return loadPromptMarkdown("optimize.system.md", DEFAULT_OPTIMIZE_SYSTEM_PROMPT);
}

export function buildFavoriteNamerSystemPrompt(): string {
  return loadPromptMarkdown("favorite.namer.system.md", DEFAULT_FAVORITE_NAMER_SYSTEM_PROMPT);
}
