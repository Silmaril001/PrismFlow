precision highp float;

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv0 = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 uv = uv0;

    float progress = fract(iTime * 0.4);
    float d = length(uv);

    vec3 bgCenter = vec3(0.05, 0.07, 0.10);
    vec3 bgEdge   = vec3(0.02);
    float bgR = length(uv0) * 1.35;
    vec3 bgColor = mix(bgCenter, bgEdge, smoothstep(0.0, 0.9, bgR));

    vec3 waveCol = vec3(0.2, 0.5, 1.0);
    vec3 dotCol = vec3(1.0);

    float wave = smoothstep(progress - 0.25, progress, d) *
                 smoothstep(progress + 0.02, progress, d);

    float glowWide = smoothstep(progress - 0.28, progress, d) *
                     smoothstep(progress + 0.10, progress, d);

    float glowSoft = smoothstep(progress - 0.42, progress, d) *
                     smoothstep(progress + 0.22, progress, d);

    float scanLimit = smoothstep(1.02, 0.98, d);

    vec2 guv = uv * 45.0;
    vec2 gid = floor(guv);
    vec2 cell = fract(guv) - 0.5;

    float aa = fwidth(length(cell)) * 1.2;
    float dotShape = smoothstep(0.35 + aa, 0.20 - aa, length(cell));

    float distFade = exp(-d * 2.0);
    float dotMask = dotShape *
                    smoothstep(progress - 0.4, progress, d) *
                    step(d, progress) *
                    distFade *
                    scanLimit;

    float micro = 0.92 + 0.08 * sin(dot(gid, vec2(17.0, 41.0)));
    dotMask *= micro;

    float corePulse = exp(-40.0 * d * d) * (0.3 + 0.7 * smoothstep(0.0, 0.12, progress));

    vec3 col = bgColor;
    col = mix(col, waveCol, wave * 0.3 + glowWide * 0.10 + glowSoft * 0.05);
    col += waveCol * glowWide * 0.18 * distFade;
    col += waveCol * glowSoft * 0.08 * distFade;
    col += dotCol * dotMask * 1.2;
    col += waveCol * corePulse * 0.08;

    float centerOcc = exp(-220.0 * d * d);
    col -= waveCol * centerOcc * 0.03;

    float vignette = smoothstep(1.2, 0.15, length(uv0));
    col *= 0.98 + 0.02 * vignette;

    float grain = fract(sin(dot(fragCoord + vec2(iTime * 37.2, iTime * 11.7), vec2(12.9898, 78.233))) * 43758.5453);
    col += (grain - 0.5) * 0.008;

    col = pow(max(col, 0.0), vec3(0.4545));
    fragColor = vec4(col, 1.0);
}
