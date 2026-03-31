# 未命名Shader

## Prompt Preview
1. Goal:
   Create a dynamic, multi-layered aurora borealis effect with flowing silk-like ribbons and vertical light streaks.

2. Globals & Setup:
   - Coordinate System: `vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;` 
   - Background: Deep night sky `vec3(0.005,

## Source Prompt
1. Goal:
   Create a dynamic, multi-layered aurora borealis effect with flowing silk-like ribbons and vertical light streaks.

2. Globals & Setup:
   - Coordinate System: `vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;` 
   - Background: Deep night sky `vec3(0.005, 0.01, 0.02)`.

3. Space Distortion:
   - Global Warp: Apply `uv.x += sin(uv.y * 2.0 + iTime * 0.5) * 0.2;` to simulate ribbon curvature.
   - Domain Warping: Use a 2D FBM (Fractal Brownian Motion) to offset the UV sampling of the noise, creating organic fluid motion.

4. Element Breakdowns:
   - Aurora Ribbons: 
     - Base Shape: Use `abs(uv.y - offset)` combined with a low-frequency `sin(uv.x * 3.0 + iTime)` to define the main path.
     - Vertical Streaks: Multiply the ribbon by a high-frequency 1D noise `hash11(floor(uv.x * 100.0))` to create vertical light pillars.
     - Softness: Use `exp(-pow(dist * density, 2.0))` for a Gaussian-like vertical falloff, keeping the bottom edge sharper via `smoothstep(0.0, 0.1, uv.y + noise)`.
   - Motion: Animate noise layers using `uv.x + iTime * 0.1` and `uv.y + iTime * 0.05` at different scales to simulate wind-blown plasma.

5. Color Palette & Blending:
   - Primary Color: `vec3(0.1, 1.0, 0.5)` (Emerald Green).
   - Secondary Color: `vec3(0.0, 0.4, 0.8)` (Deep Cyan) for the upper fringes.
   - Blending: Use additive blending `finalColor += ribbonColor * intensity` to simulate light accumulation. 
   - Post-processing: Apply a subtle `pow(color, vec3(0.8))` for HDR-like vibrance.

Saved At: 2026-03-31T04:46:40.207Z