precision highp float;

float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 5; i++)
    {
        v += a * noise(p);
        p = m * p;
        a *= 0.5;
    }
    return v;
}

vec2 warp(vec2 p, float t)
{
    vec2 q = vec2(
        fbm(p * 0.5 + vec2(0.0, t * 0.1)),
        fbm(p * 0.5 + vec2(5.2, -t * 0.1))
    );
    return p + (q - 0.5) * 0.45;
}

float auroraBand(vec2 uv, float xScale, float yOff, float speed, float seed)
{
    float t = iTime * 0.5 * speed;

    vec2 p = uv;
    p.x *= xScale;
    p.y += yOff;

    float sway = sin(p.x * 1.2 + iTime * 0.3 + seed) * 0.15;
    p.y += sway;

    vec2 pw = warp(p, t);

    float localY = p.y - 0.22;
    float band = smoothstep(0.0, 0.1, p.y + 0.2) * exp(-p.y * 1.5);
    band *= 0.94 + 0.28 * sin(p.x * 0.85 + t * 0.45 + seed);
    band = smoothstep(0.0, 1.15, band);

    vec2 flow = pw;
    flow.x += t * 0.22;
    flow.y += 0.08 * sin(pw.x * 2.0 - t * 0.6 + seed);

    float shape = fbm(flow * vec2(1.1, 2.6) + vec2(0.0, -t * 0.18));
    shape += 0.55 * fbm(flow * vec2(2.0, 4.7) + vec2(t * 0.11, t * 0.07) + seed);
    shape /= 1.55;

    float curtains = pow(noise(vec2(pw.x * 6.0 + seed * 7.31 - t * 0.35, 0.0)), 2.0);
    curtains *= 0.65 + 0.35 * noise(vec2(pw.x * 14.0 + t * 0.2, seed * 3.1));
    curtains *= 0.7 + 0.3 * smoothstep(0.1, 0.8, shape);

    float wispyTop = smoothstep(0.0, 0.7, 1.0 - abs(p.y - 0.36) * 3.7) * fbm(flow * vec2(1.5, 3.8) + seed + 3.0);

    float layerCoord = pw.y * 18.0 + shape * 5.5 + sin(pw.x * 3.0 + t * 0.7 + seed) * 1.8;
    float strata1 = 0.5 + 0.5 * sin(layerCoord);
    float strata2 = 0.5 + 0.5 * sin(layerCoord * 1.8 + 1.3);
    float strata3 = 0.5 + 0.5 * sin(layerCoord * 2.7 - 0.9);
    float strata = strata1 * 0.5 + strata2 * 0.32 + strata3 * 0.18;
    strata = smoothstep(0.38, 0.98, strata);

    float subBands = 0.0;
    subBands += exp(-abs(localY + 0.14 + 0.03 * sin(pw.x * 1.8 + seed)) * 18.0) * 0.85;
    subBands += exp(-abs(localY + 0.02 + 0.02 * sin(pw.x * 2.9 - seed * 1.7)) * 24.0) * 0.65;
    subBands += exp(-abs(localY - 0.11 + 0.02 * sin(pw.x * 2.1 + seed * 0.7)) * 20.0) * 0.45;
    subBands *= 0.55 + 0.45 * shape;

    float intensity = shape * curtains * band;
    intensity *= 0.8 + 0.65 * strata;
    intensity += subBands * band * 0.22;
    intensity += wispyTop * 0.18 * band;
    intensity *= smoothstep(0.0, 0.82, intensity);
    intensity *= smoothstep(-0.45, 0.25, uv.y);
    intensity *= exp(-max(uv.y - 0.58, 0.0) * 3.5);

    return intensity;
}

float auroraRim(vec2 uv, float xScale, float yOff, float speed, float seed)
{
    float t = iTime * 0.5 * speed;

    vec2 p = uv;
    p.x *= xScale;
    p.y += yOff;

    float sway = sin(p.x * 1.2 + iTime * 0.3 + seed) * 0.15;
    p.y += sway;

    vec2 pw = warp(p, t);

    vec2 flow = pw;
    flow.x += t * 0.22;
    flow.y += 0.08 * sin(pw.x * 2.0 - t * 0.6 + seed);

    float shape = fbm(flow * vec2(1.1, 2.6) + vec2(0.0, -t * 0.18));
    shape += 0.55 * fbm(flow * vec2(2.0, 4.7) + vec2(t * 0.11, t * 0.07) + seed);
    shape /= 1.55;

    float curtains = pow(noise(vec2(pw.x * 6.0 + seed * 7.31 - t * 0.35, 0.0)), 2.0);
    curtains *= 0.65 + 0.35 * noise(vec2(pw.x * 14.0 + t * 0.2, seed * 3.1));

    float lowerEdge = -0.14 + 0.028 * sin(pw.x * 2.2 + t * 0.8 + seed) + 0.018 * fbm(vec2(pw.x * 1.8 - t * 0.3, seed + 1.7));
    float rim = exp(-abs((p.y - 0.22) - lowerEdge) * 10.0);
    rim = pow(rim, 2.0);
    float split = smoothstep(-0.035, 0.008, (p.y - 0.22) - lowerEdge) * (1.0 - smoothstep(0.008, 0.06, (p.y - 0.22) - lowerEdge));
    rim *= 0.8 + 0.7 * split;

    float breakups = 0.55 + 0.45 * smoothstep(0.2, 0.9, shape) * (0.6 + 0.4 * curtains);
    rim *= breakups;
    rim *= smoothstep(-0.45, 0.2, uv.y);
    rim *= exp(-max(uv.y - 0.4, 0.0) * 5.0);

    return rim;
}

vec3 auroraColor(vec2 uv, float intensity, float hueShift)
{
    vec3 green = vec3(0.1, 1.0, 0.4);
    vec3 blue  = vec3(0.0, 0.3, 0.8);

    float h = pow(clamp(uv.y * 0.9 + 0.28, 0.0, 1.0), 0.5);
    float topMix = smoothstep(0.04, 0.9, h + 0.05 * sin(uv.x * 2.0 + hueShift));
    vec3 col = mix(green, blue, topMix);

    vec3 fringe = mix(
        vec3(0.08, 0.95, 0.45),
        vec3(0.35, 0.95, 1.2),
        0.5 + 0.5 * sin(vec3(0.0, 1.2, 2.2) + hueShift + intensity * 3.0)
    );

    vec3 magentaLift = vec3(0.55, 0.18, 0.75);
    col = mix(col, fringe, smoothstep(0.28, 1.0, intensity));
    col += magentaLift * smoothstep(0.72, 1.25, intensity) * 0.12;
    return col * intensity;
}

float stars(vec2 uv)
{
    vec2 p = uv * vec2(iResolution.x / iResolution.y, 1.0);
    vec2 gv = fract(p * 55.0) - 0.5;
    vec2 id = floor(p * 55.0);
    float n = hash21(id);
    float d = length(gv);
    float s = smoothstep(0.06, 0.0, d);
    s *= smoothstep(0.985, 1.0, n);
    s *= 0.4 + 0.6 * sin(n * 123.4 + iTime * 0.7);
    return s * smoothstep(-0.2, 0.55, uv.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float t = iTime * 0.5;

    vec3 col = vec3(0.005, 0.01, 0.02);

    float skyGrad = smoothstep(-0.55, 0.65, uv.y);
    col += vec3(0.0, 0.03, 0.07) * skyGrad * 0.55;
    col += vec3(0.0, 0.01, 0.03) * (0.5 + 0.5 * fbm(uv * vec2(1.1, 0.8) + t * 0.05)) * skyGrad * 0.35;

    float l1 = auroraBand(uv + vec2(0.00,  0.02), 0.90,  0.00, 0.8, 0.7);
    float l2 = auroraBand(uv + vec2(0.08, -0.05), 1.22, -0.08, 1.2, 2.1);
    float l3 = auroraBand(uv + vec2(-0.12, 0.09), 1.56,  0.10, 1.0, 4.3);
    float l4 = auroraBand(uv + vec2(0.18, 0.14), 1.95,  0.18, 1.35, 5.9);

    float r1 = auroraRim(uv + vec2(0.00,  0.02), 0.90,  0.00, 0.8, 0.7);
    float r2 = auroraRim(uv + vec2(0.08, -0.05), 1.22, -0.08, 1.2, 2.1);
    float r3 = auroraRim(uv + vec2(-0.12, 0.09), 1.56,  0.10, 1.0, 4.3);
    float r4 = auroraRim(uv + vec2(0.18, 0.14), 1.95,  0.18, 1.35, 5.9);

    vec3 a1 = auroraColor(uv + vec2(0.0, 0.02), l1 * 1.45, 0.2);
    vec3 a2 = auroraColor(uv + vec2(0.0, 0.07), l2 * 1.18, 1.1);
    vec3 a3 = auroraColor(uv + vec2(0.0, 0.11), l3 * 1.00, 2.2);
    vec3 a4 = auroraColor(uv + vec2(0.0, 0.16), l4 * 0.72, 3.4);

    col += a1;
    col += a2;
    col += a3;
    col += a4;

    vec3 rimCol =
        vec3(0.72, 1.45, 0.92) * r1 * 0.93 +
        vec3(0.62, 1.25, 1.08) * r2 * 0.825 +
        vec3(0.56, 1.05, 1.18) * r3 * 0.72 +
        vec3(0.50, 0.92, 1.12) * r4 * 0.57;

    float intensity = clamp(l1 * 0.95 + l2 * 0.8 + l3 * 0.65 + l4 * 0.5, 0.0, 1.5);

    col += rimCol;
    col += rimCol * 2.0 * intensity;
    col += rimCol * rimCol * 0.35;

    float glow = l1 * l1 * 1.05 + l2 * l2 * 0.86 + l3 * l3 * 0.66 + l4 * l4 * 0.42;
    float rimGlow = r1 * 1.2 + r2 * 1.0 + r3 * 0.8 + r4 * 0.6;

    col += vec3(0.03, 0.25, 0.16) * glow * 2.6;
    col += vec3(0.02, 0.08, 0.18) * glow * smoothstep(0.05, 0.85, uv.y + 0.12) * 1.55;
    col += vec3(0.0, 0.25, 0.20) * glow * exp(-abs(uv.y - 0.12) * 4.0) * 0.46;
    col += vec3(0.22, 0.55, 0.42) * rimGlow * exp(-abs(uv.y - 0.02) * 7.5) * 0.28;

    float horizonFog = exp(-abs(uv.y + 0.34) * 9.5) * (0.24 + 0.16 * fbm(vec2(uv.x * 2.0, t * 0.2)));
    col += vec3(0.0, 0.08, 0.07) * horizonFog;

    float st = stars(uv + vec2(t * 0.01, 0.0));
    col += vec3(0.5, 0.7, 1.0) * st * 0.55;

    float vignette = 1.0 - dot(uv * vec2(0.85, 1.15), uv * vec2(0.85, 1.15)) * 0.7;
    col *= smoothstep(-0.2, 1.0, vignette);

    col = 1.0 - exp(-col * 1.38);

    float grain = hash21(fragCoord + fract(iTime) * 137.1) - 0.5;
    col += grain * 0.015;

    fragColor = vec4(col, 1.0);
}
