export const DEFAULT_FRAGMENT_SHADER = `precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord.xy / iResolution.xy;
  float wave = 0.5 + 0.5 * sin((uv.x * 8.0) + iTime * 1.2);
  vec3 color = mix(vec3(0.05, 0.1, 0.25), vec3(0.2, 0.6, 1.0), wave);
  fragColor = vec4(color, 1.0);
}
`;
