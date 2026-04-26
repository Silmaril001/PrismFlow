# PrismFlow User Guide

Try it now: https://prismflow.duckdns.org/

PrismFlow is an online GLSL shader generation and iteration tool.
You describe a visual idea in plain language, and PrismFlow generates shader code with live preview.

This guide is written for first-time users with no coding background.

---

## What Is PrismFlow?

PrismFlow helps you:
- Turn visual ideas into animated shaders quickly
- Iterate results with AI-assisted optimization
- Save and browse works in a public gallery

Best for:
- Designers
- Motion artists
- Visual experimenters

---

## Quick Start (3 Minutes)

1. Open the PrismFlow link you received.
2. Click `Open Ideation Chat` (recommended).
3. Describe your target effect in chat (you can upload 1 image or 1 video).
4. Click `Confirm & Fill Main Prompt`.
5. Back on the main panel, click `Send`.
6. Preview the result on the right. If you like it, click the star to favorite it.

You can also skip ideation and type directly in the main prompt box.

---

## Most Important Feature: Ideation Chat

If you have a vague visual feeling but cannot describe it precisely, start with Ideation Chat.

What it does:
- Refines rough ideas into better GLSL prompts
- Uses your image/video reference to improve quality
- Reduces random or repetitive outputs

Recommended workflow:
1. Open Ideation Chat
2. Chat and refine
3. Confirm and fill main prompt
4. Generate in main panel

---

## Core Features (Simple)

- `Open Ideation Chat`: refine your request first (supports 1 image / 1 video)
- `Send`: generate shader code from your prompt
- `Parallel Count`: generate multiple candidates at once
- `New Shader`: reset context and start from scratch
- `Code Debug`: auto-fix problematic GLSL
- `One-Click Optimize`: improve current result with screenshot + context
- `Logs`: browse generation logs
- `Favorites`: browse the public favorites gallery

Notes:
- Favorites are public.
- Public favorites cannot be renamed or deleted.

---

## Common Errors and What They Mean

### 1) `Another request is already processing for this session. Please wait and retry.`

Meaning:
- Too many heavy tasks are running in the same session.

What to do:
- Wait 5-15 seconds, then retry.
- Lower `Parallel Count` if needed.

### 2) `Too many requests` / HTTP `429`

Meaning:
- You hit rate limits by clicking too frequently.

What to do:
- Wait for the cooldown, then retry.
- Avoid repeated rapid clicks.

### 3) `GEMINI_API_KEY/OPENAI_API_KEY is missing for ideation flow.`

Meaning:
- Server-side key/config issue.

What to do:
- Report it in the Discord group (link below).

### 4) `Internal server error` or request timeout

Meaning:
- Temporary server/network issue.

What to do:
- Refresh and retry once.
- If it persists, report with screenshot and error text.

### 5) `Session not found`

Meaning:
- Your session expired or became invalid.

What to do:
- Refresh the page and start a new session.

---

## If You Need Help

Please join our Discord discussion group:

- https://discord.gg/8kS3jjHjD

When reporting an issue, include:
- What you clicked (step by step)
- Full error text
- Screenshot
- Approximate time

---

## For Developers

Technical and deployment docs are in `docs/` (for example `M1_NEON_R2_DO_PLAYBOOK.md`).
