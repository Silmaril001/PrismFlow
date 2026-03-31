precision highp float;

float hash11(float p)
{
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

mat2 rot(float a)
{
    float s = sin(a), c = cos(a);
    return mat2(c,-s,s,c);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 center = vec2(0.0, 0.0);
    vec2 p = uv - center;
    float t = iTime;

    vec3 bg = vec3(0.02, 0.01, 0.0);
    vec3 gold = vec3(1.0, 0.5, 0.1);
    vec3 hot  = vec3(1.0, 0.9, 0.6);
    vec3 color = bg;

    float r = length(p);
    float ang = atan(p.y, p.x);

    // 沿用第一段的基础光晕与太阳参数，确保天空部分的视觉基调
    float horizonGlow = pow(1.0 - abs(uv.y), 50.0) * exp(-uv.x * uv.x * 2.0);
    color += horizonGlow * vec3(1.0, 0.4, 0.1) * 1.6;

    float sunGlow = 0.02 / pow(max(length(p), 0.001), 1.1);
    color += sunGlow * mix(gold, hot, 0.55) * 1.9;

    float sunCore = smoothstep(0.028, 0.0, r);
    color += hot * sunCore * 4.0;

    float ringR = 0.02;
    float ringW = fwidth(r) * 2.0 + 0.002;
    float sunRing = 1.0 - smoothstep(ringR - ringW, ringR + ringW, r);
    color += hot * sunRing * 1.6;

    float corona = pow(max(0.0, 1.0 - r * 10.0), 3.0);
    color += mix(gold, hot, 0.7) * corona * (0.5 + 0.5 * sin(t * 3.0 + ang * 8.0));

    if (uv.y >= 0.0)
    {
        // 提取自第一段：天空与光芒渲染逻辑
        vec2 suv = p;
        float angle = atan(suv.y, suv.x);
        float radius = length(suv);

        float seg = floor((angle + 3.14159265) / 6.2831853 * 180.0);
        float h = hash11(seg + 17.3);

        float centerMask = exp(-radius * 3.2);
        float outerMask = smoothstep(0.0, 0.5, radius);
        float skyPulse = 0.65 + 0.35 * sin(t * 1.4 + angle * 7.0 + sin(t * 0.7 + angle * 3.0) * 1.3);
        float skyPulse2 = 0.7 + 0.3 * sin(t * 2.1 - angle * 11.0 + radius * 8.0);

        float rayBaseRaw = 0.5 + 0.5 * sin(angle * 34.0 + sin(angle * 9.0 + t * 0.35) * 2.4 + t * 0.22);
        float rayBase = mix(pow(rayBaseRaw, 2.4), pow(rayBaseRaw, 5.5), smoothstep(0.08, 0.55, radius));

        float rayFine = 0.5 + 0.5 * sin(angle * 80.0 - t * 1.05 + h * 31.0 + radius * 10.0);
        rayFine *= outerMask;

        float rayLobe = 0.5 + 0.5 * sin(angle * 15.0 - t * 0.55 + h * 9.0);
        rayLobe = mix(pow(rayLobe, 1.8), pow(rayLobe, 4.0), smoothstep(0.12, 0.65, radius));

        float rayIntensity = mix(rayBase, rayFine, 0.28) * mix(1.35, 0.75, smoothstep(0.0, 0.8, radius));
        rayIntensity = mix(rayIntensity, max(rayIntensity, rayLobe), 0.55);
        rayIntensity *= skyPulse * skyPulse2;

        float rays = pow(rayIntensity, mix(1.8, 3.6, smoothstep(0.05, 0.75, radius))) * exp(-radius * 1.75);
        float spoke = smoothstep(mix(0.55, 0.82, smoothstep(0.0, 0.7, radius)), 1.0, rayIntensity) * exp(-radius * 1.15);
        spoke *= mix(1.55, 0.65, smoothstep(0.0, 0.6, radius));

        float sunBurst = pow(max(0.0, 1.0 - radius * 1.3), 2.5);
        float centerFlare = centerMask * (0.55 + 0.45 * sin(t * 1.8 + angle * 5.0 + radius * 14.0));

        color += gold * rays * 1.45;
        color += hot * spoke * 1.2;
        color += vec3(1.0, 0.35, 0.08) * sunBurst * 0.55;
        color += mix(gold, hot, 0.65) * centerFlare * max(0.0, rayLobe - 0.25) * 0.35;

        float arc = exp(-abs(radius - 0.42) * 11.0) * smoothstep(0.0, 0.18, uv.y);
        color += vec3(1.0, 0.32, 0.08) * arc * 0.15;
    }
    else
    {
        // 提取自第二段：地面与运动轨迹逻辑
        float ay = max(abs(uv.y), 0.02);
        vec2 p_uv = vec2(uv.x / ay, 1.0 / ay + t * 5.0); // 维持第二段的速度 t * 5.0

        float lane = p_uv.x * 20.0;
        float id = floor(lane);
        float fracx = fract(lane);
        float lineWidth = smoothstep(0.1, 0.0, abs(fracx - 0.5));

        float rnd = hash21(vec2(id, floor(p_uv.y)));
        float rnd2 = hash21(vec2(id, floor(p_uv.y * 0.5) + 13.7));
        float seg = fract(p_uv.y + rnd * 2.0);
        float dash = smoothstep(0.0, 0.08 + rnd * 0.12, seg) * (1.0 - smoothstep(0.55 + rnd * 0.15, 1.0, seg));

        float perspective = smoothstep(0.0, 0.45, -uv.y);
        float centerBias = exp(-abs(uv.x) * 2.7);
        float brightness = mix(0.6, 1.7, rnd) * mix(0.8, 1.5, centerBias);
        float warmMix = smoothstep(0.0, 0.7, hash11(id + 2.3));

        vec3 streakCol = mix(gold, vec3(1.0, 0.22, 0.05), warmMix);
        float streak = lineWidth * dash * perspective * brightness / (0.45 + ay * 8.0);

        color += streakCol * streak * 1.9;

        float fracY = fract(p_uv.y * 0.45 + rnd2);
        float spark = smoothstep(0.03, 0.0, abs(fracx - 0.5)) *
                      smoothstep(0.0, 0.04, fracY) *
                      perspective * (0.8 + rnd2 * 1.4) / (0.35 + ay * 10.0);
        color += hot * spark * 1.8;

        float roadBeam = exp(-abs(abs(uv.x) - (-uv.y) * 0.78) * 22.0) * smoothstep(0.0, 0.6, -uv.y);
        float roadBeam2 = exp(-abs(abs(uv.x) - (-uv.y) * 0.52) * 34.0) * smoothstep(0.0, 0.35, -uv.y);
        color += vec3(1.0, 0.14, 0.04) * roadBeam * 0.95;
        color += gold * roadBeam2 * 0.45;

        float floorGlow = exp(-abs(uv.x) * 1.8) * smoothstep(0.0, 0.75, -uv.y) * exp(-ay * 2.0);
        color += vec3(0.65, 0.18, 0.03) * floorGlow * 0.22;
    }

    // 后期光效融合（沿用第一段参数以适配天空）
    float horizonBand = pow(1.0 - abs(uv.y), 50.0);
    float horizonCore = exp(-uv.x * uv.x * 2.0);
    color += mix(gold, hot, 0.5) * horizonBand * (0.5 + horizonCore * 1.6);

    float radialBurst = pow(max(0.0, 1.0 - r * 1.8), 5.0);
    float burstLines = pow(0.5 + 0.5 * sin(ang * 32.0 + t * 0.7), 8.0) * radialBurst;
    color += hot * burstLines * 0.45;

    float vignette = 1.0 - smoothstep(0.55, 1.2, length(uv * vec2(0.92, 1.15)));
    color *= mix(0.65, 1.0, vignette);

    vec2 n = fragCoord.xy;
    float grain = hash21(n + fract(t) * 123.4) - 0.5;
    color += grain * 0.018;

    color = color / (1.0 + color);
    color = pow(max(color, 0.0), vec3(0.8));

    fragColor = vec4(color, 1.0);
}