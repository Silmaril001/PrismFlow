export interface ShaderValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateShaderBasic(shaderCode: string): ShaderValidationResult {
  const errors: string[] = [];

  if (/^\s*#define\s+iTime\b/m.test(shaderCode)) {
    errors.push("Do not redefine `iTime` with `#define`.");
  }

  if (/^\s*#define\s+iResolution\b/m.test(shaderCode)) {
    errors.push("Do not redefine `iResolution` with `#define`.");
  }

  if (!/^\s*precision\s+(lowp|mediump|highp)\s+float\s*;/m.test(shaderCode)) {
    errors.push("Missing precision declaration, expected `precision highp float;`.");
  }

  const hasMain = /void\s+main\s*\(\s*\)/.test(shaderCode);
  const hasMainImage = /void\s+mainImage\s*\(\s*out\s+vec4\s+fragColor\s*,\s*in\s+vec2\s+fragCoord\s*\)/.test(
    shaderCode,
  );
  if (!hasMain && !hasMainImage) {
    errors.push(
      "Missing shader entry function. Expected `mainImage(out vec4 fragColor, in vec2 fragCoord)` or `void main()`.",
    );
  }

  const writesFragColor = /gl_FragColor\s*=/.test(shaderCode);
  const writesMainImageColor = /\bfragColor\s*=/.test(shaderCode);
  const callsMainImageWrapper = /mainImage\s*\(\s*gl_FragColor\s*,\s*gl_FragCoord\.xy\s*\)/.test(
    shaderCode,
  );
  if (!writesFragColor && !writesMainImageColor && !callsMainImageWrapper) {
    errors.push("Missing final color output assignment (`fragColor` or `gl_FragColor`).");
  }

  const hasTimeReference = /\biTime\b/.test(shaderCode);
  const hasUTimeUniform = /uniform\s+float\s+u_time\s*;/.test(shaderCode);
  if (!hasTimeReference && !hasUTimeUniform) {
    errors.push("Missing time input (`iTime` or `uniform float u_time;`).");
  }

  const hasResolutionReference = /\biResolution\b/.test(shaderCode);
  const hasUResolutionUniform = /uniform\s+vec2\s+u_resolution\s*;/.test(shaderCode);
  if (!hasResolutionReference && !hasUResolutionUniform) {
    errors.push("Missing resolution input (`iResolution` or `uniform vec2 u_resolution;`).");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
