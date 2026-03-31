precision highp float;

float hash11(float p){
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p){
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for(int i = 0; i < 5; i++){
        v += a * noise(p);
        p = m * p;
        a *= 0.5;
    }
    return v;
}

vec2 warp(vec2 p){
    vec2 ps = vec2(p.x, p.y * 0.4);
    vec2 q = vec2(
        fbm(ps * vec2(1.2, 1.6) + vec2(0.0, iTime * 0.07)),
        fbm(ps * vec2(1.2, 1.5) + vec2(4.7, -iTime * 0.05))
    );
    vec2 r = vec2(
        fbm(ps * vec2(2.2, 1.8) + q * 1.8 + vec2(iTime * 0.10, 0.0)),
        fbm(ps * vec2(2.0, 1.7) + q * 1.8 + vec2(0.0, iTime * 0.08))
    );
    vec2 w = r - 0.5;
    w.x += w.y * (0.28 + 0.22 * smoothstep(-0.2, 0.7, p.y));
    return w;
}

vec3 auroraLayer(vec2 uv, float offset, float density, float amp, float seed){
    vec2 p = uv;
    vec2 dw = warp(p * vec2(1.2, 1.8) + seed);
    p += dw * vec2(0.22, 0.02);
    p.x += dw.y * (0.10 + 0.08 * smoothstep(0.0, 0.8, p.y));

    float wave1 = sin(p.x * 3.0 + iTime + seed) * amp;
    float wave2 = sin(p.x * 1.5 - iTime * 0.43 + seed * 2.1) * amp * 0.6;

    vec2 np = vec2(p.x, p.y * 0.4);
    float flow = fbm(vec2(np.x * 1.8 + iTime * 0.10, np.y * 2.4 + iTime * 0.05 + seed)) - 0.5;
    float path = offset + wave1 + wave2 + flow * 0.18;

    float dy = p.y - path;
    float py = max(dy, 0.0);

    float ribbonEdge = smoothstep(-0.01, 0.08, dy);

    float dens = density * 1.18;
    float falloffA = exp(-pow(py * dens * 0.72, 1.02));
    float falloffB = exp(-pow(py * dens * 0.34, 1.32));
    float ribbon = ribbonEdge * (falloffA * 0.62 + falloffB * 0.38);

    float wideNoise = noise(vec2(p.x * 18.0 + seed * 9.1, np.y * 6.0 - iTime * 0.10));
    float wideBands = fbm(vec2(p.x * 4.2 + seed * 2.7, np.y * 2.0 + iTime * 0.03));
    float streakPulse = smoothstep(0.18, 0.88, 0.55 * wideNoise + 0.75 * wideBands);

    float fine = fbm(vec2(p.x * 7.0 - iTime * 0.10 + seed * 3.1, np.y * 4.2 + iTime * 0.06 + seed));
    float softBands = fbm(vec2(p.x * 2.0 + seed * 5.7, py * 4.2 - iTime * 0.02));

    float streaks = mix(0.78, 1.26, streakPulse);
    streaks *= mix(0.92, 1.08, fine);
    streaks *= mix(0.90, 1.10, softBands);

    vec3 primary = vec3(0.05, 1.0, 0.4);
    vec3 secondary = vec3(0.0, 0.4, 0.8);
    float highRegion = smoothstep(0.02, 0.28, py);
    float colorMix = clamp(highRegion * 1.10 + py * 1.18 + 0.06 * fine - streakPulse * 0.10, 0.0, 1.0);
    vec3 ribbonColor = mix(primary, secondary, colorMix);

    float lowerHighlight = exp(-py * dens * 1.65) * ribbonEdge;
    lowerHighlight *= mix(0.86, 1.08, fine);
    lowerHighlight *= 0.22;

    float bodyLight = exp(-pow(py * dens * 0.72, 1.08)) * 0.16;
    float filamentCore = exp(-pow(py * dens * 1.10, 1.25)) * (0.16 + 0.10 * streakPulse) * ribbonEdge;
    float centerBloom = exp(-pow(py * dens * 0.55, 0.88)) * (0.18 + 0.12 * softBands) * ribbonEdge;

    float intensity = ribbon * streaks + lowerHighlight + bodyLight + filamentCore + centerBloom;
    intensity = pow(max(intensity, 0.0), 1.08);
    intensity = intensity / (1.0 + intensity * 0.54);

    vec3 finalColor = ribbonColor * intensity * 2.5;
    finalColor *= vec3(0.95, 1.0, 0.98);

    return finalColor;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 suv = uv;

    vec3 color = vec3(0.005, 0.01, 0.02);

    uv.x += sin(uv.y * 2.0 + iTime * 0.5) * 0.2;

    float skyGrad = smoothstep(-0.55, 0.65, uv.y);
    color += vec3(0.0, 0.01, 0.025) * skyGrad * 0.8;

    float stars = 0.0;
    vec2 sp = fragCoord / iResolution.xy;
    float s1 = hash21(floor(sp * vec2(420.0, 240.0)));
    float s2 = hash21(floor(sp * vec2(760.0, 420.0) + 17.3));
    stars += smoothstep(0.997, 1.0, s1) * 0.6;
    stars += smoothstep(0.9985, 1.0, s2) * 0.8;
    color += vec3(0.35, 0.45, 0.6) * stars * (1.0 - smoothstep(-0.2, 0.4, uv.y));

    vec3 aur = vec3(0.0);

    vec3 nearAur = auroraLayer(uv * vec2(0.92, 1.12) - vec2(0.18, 0.02), 0.08, 12.0, 0.07, 3.4);
    vec3 midAur  = auroraLayer(uv * vec2(1.00, 1.00), 0.18, 8.5, 0.09, 0.0);
    vec3 farAur  = auroraLayer(uv * vec2(1.08, 0.95) + vec2(0.12, 0.03), 0.28, 10.0, 0.08, 1.7);

    nearAur *= vec3(1.00, 1.03, 1.00) * 1.28;
    midAur  *= vec3(0.94, 0.98, 1.00) * 0.92;
    farAur  *= vec3(0.82, 0.90, 1.02) * 0.56;

    aur += farAur;
    aur += midAur;
    aur += nearAur;

    aur = aur / (1.0 + aur * 0.32);

    color += aur;

    float haze = fbm(suv * vec2(1.5, 0.8) + vec2(0.0, iTime * 0.015));
    float hazeMask = smoothstep(0.02, 0.55, suv.y);
    color *= 1.0 + vec3(0.0, 0.008, 0.012) * haze * hazeMask * 0.02;

    float vignette = 1.0 - dot(suv * 0.8, suv * 0.55);
    vignette = smoothstep(-0.2, 1.0, vignette);
    color *= vignette;

    float grain = hash21(fragCoord + fract(iTime) * 137.0) - 0.5;
    color += grain * 0.012;

    color = pow(max(color, 0.0), vec3(0.86));
    color = color / (1.0 + color * 0.22);

    fragColor = vec4(color, 1.0);
}
