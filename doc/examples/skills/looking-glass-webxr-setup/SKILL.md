---
name: looking-glass-webxr-setup
description: Integrate and troubleshoot Looking Glass WebXR in browser-based 3D apps with monitor fallback and correct depth layering.
---

# Looking Glass WebXR Setup

Use this skill when the user wants holographic output on Looking Glass while keeping normal monitor rendering available.

## Preconditions

- Looking Glass Bridge is installed and running.
- Browser is Chromium-based or Firefox (Safari is unsupported).
- For macOS: browser must be windowed, not fullscreen, when starting XR popup flow.

## Integration baseline

Install:

```bash
npm install @lookingglass/webxr
```

Apply polyfill before requesting XR session:

```js
import { LookingGlassWebXRPolyfill, LookingGlassConfig } from "@lookingglass/webxr";

const config = LookingGlassConfig;
config.targetY = 0;
config.targetZ = 0;
config.targetDiam = 3;
config.fovy = (40 * Math.PI) / 180;

new LookingGlassWebXRPolyfill();
```

## UI behavior requirements

- Keep monitor mode as default fallback.
- Provide explicit button for XR entry (for example `View in XR` or `Enter Looking Glass`).
- Show clear state labels (`monitor`, `xr-active`, `xr-start-failed`, `xr-not-supported`).

## 3D layout and depth rules

Use a consistent axis definition and repeat it in diagnostics:

- `+x`: right
- `+y`: up
- `+z`: toward viewer

When composing a face model:

- Keep facial features in front of the head surface.
- Keep hair behind face features but still visible from camera framing.
- Validate near/far clipping so eyebrows/eyes are not hidden unexpectedly.

## Troubleshooting checklist

If UI shows `XR NOT SUPPORTED`:

1. Confirm Bridge is running.
2. Confirm supported browser.
3. Confirm polyfill is initialized before session request.
4. Confirm XR popup window was created and moved to Looking Glass display.
5. Confirm the popup was activated as required by vendor flow.

If official sample works but your app fails:

- Compare XR entry path ordering.
- Reuse vendor-style `Enter Looking Glass` flow first, then reintroduce custom UI.

## Validation sequence

1. Start app in monitor mode and verify scene centering.
2. Enter XR mode and verify state transition labels.
3. Exit XR and verify monitor mode recovery.
4. Resize window and confirm camera/framing adapt without clipping jaw or top of head.
