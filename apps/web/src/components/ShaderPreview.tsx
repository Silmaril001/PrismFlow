import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const VERTEX_SHADER_WEBGL1 = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const VERTEX_SHADER_WEBGL2 = `#version 300 es
in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FALLBACK_FRAGMENT = `
precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord.xy / iResolution.xy;
  vec3 color = vec3(uv.x, 0.3 + 0.2 * sin(iTime), uv.y);
  fragColor = vec4(color, 1.0);
}
`;

// Use one oversized fullscreen triangle to avoid the diagonal seam that can
// appear with two-triangle strips in some shaders/GPUs.
const FULLSCREEN_TRIANGLE_VERTICES = new Float32Array([
  -1, -1,
  3, -1,
  -1, 3,
]);

interface ShaderPreviewProps {
  fragmentShader: string;
  viewportWidth: number;
  viewportHeight: number;
  paused?: boolean;
  showCompileError?: boolean;
  onCompileErrorChange?: (message: string) => void;
}

export interface ShaderPreviewHandle {
  captureAtTime(seconds: number): Promise<string>;
}

type PreviewTarget = "webgl1" | "webgl2";

type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

const WEBGL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false,
  alpha: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  desynchronized: true,
  powerPreference: "high-performance",
};

function isWebGL2Context(gl: GLContext): gl is WebGL2RenderingContext {
  return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
}

function createGLContext(canvas: HTMLCanvasElement): GLContext | null {
  return (
    (canvas.getContext("webgl2", WEBGL_CONTEXT_ATTRIBUTES) as GLContext | null) ??
    canvas.getContext("webgl", WEBGL_CONTEXT_ATTRIBUTES)
  );
}

function prepareGLState(gl: GLContext): void {
  gl.disable(gl.DITHER);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
}

export function normalizeShaderForPreview(raw: string, target: PreviewTarget): string {
  let normalized = raw;
  normalized = normalized.replace(/^\s*#define\s+iTime\b.*$/gm, "");
  normalized = normalized.replace(/^\s*#define\s+iResolution\b.*$/gm, "");
  normalized = normalized.replace(/^\s*#version[^\n]*\n?/gm, "");

  const hasPrecision = /^\s*precision\s+(lowp|mediump|highp)\s+float\s*;/m.test(normalized);
  const injections: string[] = [];

  const hasUTimeUniform = /uniform\s+float\s+u_time\s*;/.test(normalized);
  const hasUResolutionUniform = /uniform\s+vec2\s+u_resolution\s*;/.test(normalized);
  const hasITimeUniform = /uniform\s+float\s+iTime\s*;/.test(normalized);
  const hasIResolutionUniform = /uniform\s+vec[234]\s+iResolution\s*;/.test(normalized);
  const usesITime = /\biTime\b/.test(normalized);
  const usesIResolution = /\biResolution\b/.test(normalized);

  if (!hasUTimeUniform) {
    injections.push("uniform float u_time;");
  }

  if (!hasUResolutionUniform) {
    injections.push("uniform vec2 u_resolution;");
  }

  if (usesITime && !hasITimeUniform) {
    injections.push("uniform float iTime;");
  }

  if (usesIResolution && !hasIResolutionUniform) {
    injections.push("uniform vec3 iResolution;");
  }

  const outVarName = "shaderPreviewOutColor";
  if (target === "webgl2") {
    injections.push(`out vec4 ${outVarName};`);
    normalized = normalized.replace(/\bgl_FragColor\b/g, outVarName);
  }

  if (hasPrecision) {
    if (injections.length > 0) {
      normalized = normalized.replace(
        /^\s*precision\s+(lowp|mediump|highp)\s+float\s*;\s*$/m,
        (match) => `${match}\n${injections.join("\n")}`,
      );
    }
  } else {
    const headerLines: string[] = ["precision highp float;", ...injections];
    normalized = `${headerLines.join("\n")}\n${normalized}`;
  }

  const hasMain = /void\s+main\s*\(\s*\)/.test(normalized);
  const hasMainImage = /void\s+mainImage\s*\(/.test(normalized);
  if (!hasMain && hasMainImage) {
    if (target === "webgl2") {
      normalized += `\nvoid main() {\n  mainImage(${outVarName}, gl_FragCoord.xy);\n}\n`;
    } else {
      normalized += "\nvoid main() {\n  mainImage(gl_FragColor, gl_FragCoord.xy);\n}\n";
    }
  }

  if (target === "webgl2") {
    normalized = `#version 300 es\n${normalized}`;
  }

  return normalized;
}

function compileShader(
  gl: GLContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to allocate shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!success) {
    const info = gl.getShaderInfoLog(shader) ?? "unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(info);
  }

  return shader;
}

function renderStillFrameDataUrl(params: {
  fragmentShader: string;
  viewportWidth: number;
  viewportHeight: number;
  seconds: number;
}): string {
  const width = Math.max(64, Math.floor(params.viewportWidth));
  const height = Math.max(64, Math.floor(params.viewportHeight));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = createGLContext(canvas);
  if (!gl) {
    throw new Error("Browser does not support WebGL.");
  }
  prepareGLState(gl);

  const target: PreviewTarget = isWebGL2Context(gl) ? "webgl2" : "webgl1";
  const vertexSource = target === "webgl2" ? VERTEX_SHADER_WEBGL2 : VERTEX_SHADER_WEBGL1;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const normalizedFragment = normalizeShaderForPreview(
    params.fragmentShader || FALLBACK_FRAGMENT,
    target,
  );
  const fragmentShaderCompiled = compileShader(gl, gl.FRAGMENT_SHADER, normalizedFragment);

  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShaderCompiled);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const programError = gl.getProgramInfoLog(program) ?? "program link error";
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShaderCompiled);
    throw new Error(programError);
  }

  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE_VERTICES, gl.STATIC_DRAW);

  const positionLoc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

  const timeLoc = gl.getUniformLocation(program, "u_time");
  const resolutionLoc = gl.getUniformLocation(program, "u_resolution");
  const iTimeLoc = gl.getUniformLocation(program, "iTime");
  const iResolutionLoc = gl.getUniformLocation(program, "iResolution");
  gl.viewport(0, 0, width, height);
  if (timeLoc) {
    gl.uniform1f(timeLoc, params.seconds);
  }
  if (resolutionLoc) {
    gl.uniform2f(resolutionLoc, width, height);
  }
  if (iTimeLoc) {
    gl.uniform1f(iTimeLoc, params.seconds);
  }
  if (iResolutionLoc) {
    gl.uniform3f(iResolutionLoc, width, height, 1.0);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const dataUrl = canvas.toDataURL("image/png");
  if (positionBuffer) {
    gl.deleteBuffer(positionBuffer);
  }
  gl.deleteProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShaderCompiled);
  return dataUrl;
}

export function captureShaderStillFrameDataUrl(params: {
  fragmentShader: string;
  viewportWidth: number;
  viewportHeight: number;
  seconds: number;
}): string {
  return renderStillFrameDataUrl(params);
}

export const ShaderPreview = forwardRef<ShaderPreviewHandle, ShaderPreviewProps>(function ShaderPreview(
  {
    fragmentShader,
    viewportWidth,
    viewportHeight,
    paused = false,
    showCompileError = true,
    onCompileErrorChange,
  }: ShaderPreviewProps,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [compileError, setCompileError] = useState<string>("");
  const [rendererTag, setRendererTag] = useState<string>("");

  useImperativeHandle(
    ref,
    () => ({
      async captureAtTime(seconds: number): Promise<string> {
        return renderStillFrameDataUrl({
          fragmentShader,
          viewportWidth,
          viewportHeight,
          seconds,
        });
      },
    }),
    [fragmentShader, viewportWidth, viewportHeight],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

  const gl = createGLContext(canvas);
  if (!gl) {
    setCompileError("Browser does not support WebGL.");
    setRendererTag("NO GL");
    return;
  }
  prepareGLState(gl);
  const target: PreviewTarget = isWebGL2Context(gl) ? "webgl2" : "webgl1";
  setRendererTag(target === "webgl2" ? "GL2" : "GL1");

    let animationFrame = 0;
    const start = performance.now();

    try {
      const vertexSource = target === "webgl2" ? VERTEX_SHADER_WEBGL2 : VERTEX_SHADER_WEBGL1;
      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
      const normalizedFragment = normalizeShaderForPreview(
        fragmentShader || FALLBACK_FRAGMENT,
        target,
      );
      const fragmentShaderCompiled = compileShader(
        gl,
        gl.FRAGMENT_SHADER,
        normalizedFragment,
      );

      const program = gl.createProgram();
      if (!program) {
        throw new Error("Failed to create program.");
      }

      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShaderCompiled);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? "program link error");
      }

      gl.useProgram(program);

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE_VERTICES, gl.STATIC_DRAW);

      const positionLoc = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(positionLoc);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

      const timeLoc = gl.getUniformLocation(program, "u_time");
      const resolutionLoc = gl.getUniformLocation(program, "u_resolution");
      const iTimeLoc = gl.getUniformLocation(program, "iTime");
      const iResolutionLoc = gl.getUniformLocation(program, "iResolution");
      const dpr =
        typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
      const cssWidth = Math.max(64, Math.floor(canvas.clientWidth || viewportWidth));
      const cssHeight = Math.max(64, Math.floor(canvas.clientHeight || viewportHeight));
      const width = Math.max(64, Math.floor(cssWidth * dpr));
      const height = Math.max(64, Math.floor(cssHeight * dpr));
      canvas.width = width;
      canvas.height = height;

      const renderAtTime = (seconds: number) => {
        gl.viewport(0, 0, width, height);
        if (timeLoc) {
          gl.uniform1f(timeLoc, seconds);
        }
        if (resolutionLoc) {
          gl.uniform2f(resolutionLoc, width, height);
        }
        if (iTimeLoc) {
          gl.uniform1f(iTimeLoc, seconds);
        }
        if (iResolutionLoc) {
          gl.uniform3f(iResolutionLoc, width, height, 1.0);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };

      const cleanup = () => {
        cancelAnimationFrame(animationFrame);
        if (positionBuffer) {
          gl.deleteBuffer(positionBuffer);
        }
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShaderCompiled);
      };

      setCompileError("");
      if (paused) {
        renderAtTime(0);
        return cleanup;
      }

      const render = () => {
        renderAtTime((performance.now() - start) / 1000);
        animationFrame = requestAnimationFrame(render);
      };
      render();
      return cleanup;
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : "Unknown WebGL error.");
      return () => {
        cancelAnimationFrame(animationFrame);
      };
    }
  }, [fragmentShader, viewportWidth, viewportHeight, paused]);

  useEffect(() => {
    onCompileErrorChange?.(compileError);
  }, [compileError, onCompileErrorChange]);

  return (
    <>
      <div
        className="preview-wrapper"
        style={{
          width: `min(100%, ${Math.max(64, Math.floor(viewportWidth))}px)`,
          aspectRatio: `${Math.max(64, Math.floor(viewportWidth))} / ${Math.max(
            64,
            Math.floor(viewportHeight),
          )}`,
        }}
      >
        {rendererTag ? <span className="preview-engine-badge">{rendererTag}</span> : null}
        <canvas ref={canvasRef} className="preview-canvas" />
      </div>
      {showCompileError && compileError ? <pre className="compile-error">{compileError}</pre> : null}
    </>
  );
});
