import * as THREE from 'three';
import { deriveFaceControls } from './state_engine.js';
import { applyIdleMotionToControls } from './face_idle_motion.js';
import { applyAgentFaceRuntimeDragToControls } from './agent_face_store.js';
import {
  addFaceLights,
  applyAppearanceToRig,
  applyControlsToRig,
  createFaceCamera,
  createFaceRig,
  disposeFaceRig
} from './face_rig.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intersectRect(inner, outer) {
  const left = Math.max(inner.left, outer.left);
  const right = Math.min(inner.right, outer.right);
  const top = Math.max(inner.top, outer.top);
  const bottom = Math.min(inner.bottom, outer.bottom);
  if (right <= left || bottom <= top) {
    return null;
  }
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function createTileEntry(descriptor) {
  const scene = new THREE.Scene();
  addFaceLights(scene, {
    ambientColor: 0xffffff,
    keyColor: 0xffffff,
    fillColor: 0xf7fbff,
    rimColor: 0xffffff,
    ambientIntensity: 1.54,
    keyIntensity: 1.72,
    fillIntensity: 0.78,
    rimIntensity: 0.22
  });
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(4.9, 4.9),
    new THREE.MeshBasicMaterial({
      color: 0x192532,
      transparent: true,
      opacity: 0.94,
      depthWrite: false
    })
  );
  backdrop.position.set(0, 0.54, -1.7);
  scene.add(backdrop);
  const rig = createFaceRig(scene, { appearance: descriptor.appearance });
  const camera = createFaceCamera({ fov: 34, z: 5.35, y: 0.08, lookAtY: 0.24 });
  return {
    key: descriptor.key,
    scene,
    backdrop,
    rig,
    camera
  };
}

function resolveBackdropTone(descriptor) {
  switch (descriptor?.tone) {
    case 'needs_attention':
      return { color: 0x7c4f56, opacity: 0.98 };
    case 'error':
      return { color: 0xbf3948, opacity: 0.99 };
    case 'prompt_idle':
      return { color: 0x1a2630, opacity: 0.95 };
    case 'missing':
      return { color: 0x26303b, opacity: 0.94 };
    case 'active':
    case 'working':
    case 'speaking':
    default:
      return { color: 0x40576d, opacity: 0.97 };
  }
}

function applySpeechToControls(controls, speech) {
  const mouthOpen = clamp(Number(speech?.mouthOpen ?? 0), 0, 1);
  const active = speech?.active === true || mouthOpen > 0.01;
  if (!active) {
    return controls;
  }
  controls.mouth.open = clamp(Math.max(controls.mouth.open * 0.46, mouthOpen * 1.08), 0, 1);
  controls.mouth.wide = clamp(Math.max(controls.mouth.wide, 0.44 + mouthOpen * 0.58), 0, 1);
  return controls;
}

function applyToneToControls(controls, tone) {
  if (tone === 'needs_attention') {
    controls.brows.left.raise = clamp(controls.brows.left.raise + 0.14, 0, 1);
    controls.brows.right.raise = clamp(controls.brows.right.raise + 0.14, 0, 1);
    controls.eyes.left.open = clamp(controls.eyes.left.open + 0.08, 0, 1);
    controls.eyes.right.open = clamp(controls.eyes.right.open + 0.08, 0, 1);
    controls.head.push_z = clamp((controls.head.push_z ?? 0) + 0.18, -1, 1);
  } else if (tone === 'prompt_idle') {
    controls.eyes.left.open = clamp(controls.eyes.left.open * 0.9, 0.18, 1);
    controls.eyes.right.open = clamp(controls.eyes.right.open * 0.9, 0.18, 1);
    controls.mouth.open = clamp(controls.mouth.open * 0.24, 0, 1);
    controls.mouth.wide = clamp(controls.mouth.wide * 0.72, 0, 1);
  } else if (tone === 'error') {
    controls.brows.furrow = clamp(controls.brows.furrow + 0.18, 0, 1);
    controls.brows.tilt = clamp(controls.brows.tilt - 0.1, -1, 1);
    controls.mouth.wide = clamp(controls.mouth.wide - 0.08, 0, 1);
  } else if (tone === 'missing') {
    controls.eyes.left.open = clamp(controls.eyes.left.open * 0.62, 0.02, 1);
    controls.eyes.right.open = clamp(controls.eyes.right.open * 0.62, 0.02, 1);
    controls.head.pitch = clamp(controls.head.pitch + 0.08, -1, 1);
    controls.mouth.open = clamp(controls.mouth.open * 0.45, 0, 1);
  }
  return controls;
}

export function createAgentDashboardFaceRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);

  const entries = new Map();

  function syncDescriptors(descriptors) {
    const liveKeys = new Set();
    for (const descriptor of descriptors) {
      if (!descriptor?.key) {
        continue;
      }
      liveKeys.add(descriptor.key);
      let entry = entries.get(descriptor.key);
      if (!entry) {
        entry = createTileEntry(descriptor);
        entries.set(descriptor.key, entry);
      }
      applyAppearanceToRig(entry.rig, descriptor.appearance);
      const backdropTone = resolveBackdropTone(descriptor);
      entry.backdrop.material.color.setHex(backdropTone.color);
      entry.backdrop.material.opacity = backdropTone.opacity;
    }

    for (const [key, entry] of entries.entries()) {
      if (liveKeys.has(key)) {
        continue;
      }
      entry.scene.remove(entry.backdrop);
      entry.backdrop.geometry.dispose();
      entry.backdrop.material.dispose();
      entry.scene.remove(entry.rig.root);
      disposeFaceRig(entry.rig);
      entries.delete(key);
    }
  }

  function render(descriptors, options = {}) {
    const containerEl = options.containerEl;
    if (!containerEl || !Array.isArray(descriptors) || descriptors.length === 0) {
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissorTest(true);
      return;
    }

    const width = Math.max(1, Math.round(containerEl.clientWidth));
    const height = Math.max(1, Math.round(containerEl.clientHeight));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);

    const containerRect = containerEl.getBoundingClientRect();
    syncDescriptors(descriptors);

    for (const descriptor of descriptors) {
      const entry = entries.get(descriptor.key);
      if (!entry || !descriptor.slotEl?.isConnected) {
        continue;
      }
      const slotRect = descriptor.slotEl.getBoundingClientRect();
      const visibleRect = intersectRect(slotRect, containerRect);
      if (!visibleRect || visibleRect.width < 12 || visibleRect.height < 12) {
        continue;
      }

      const viewportLeft = Math.round((visibleRect.left - containerRect.left) * dpr);
      const viewportTop = Math.round((visibleRect.top - containerRect.top) * dpr);
      const viewportWidth = Math.round(visibleRect.width * dpr);
      const viewportHeight = Math.round(visibleRect.height * dpr);
      const y = Math.round(height * dpr - viewportTop - viewportHeight);
      if (viewportWidth <= 0 || viewportHeight <= 0 || y < -viewportHeight) {
        continue;
      }

      entry.camera.aspect = visibleRect.width / visibleRect.height;
      entry.camera.updateProjectionMatrix();

      let controls = deriveFaceControls(
        descriptor.faceState,
        (options.nowMs ?? performance.now()) + (descriptor.motion?.timeOffsetMs ?? 0)
      );
      controls = applyIdleMotionToControls(
        controls,
        options.nowMs ?? performance.now(),
        descriptor.motion,
        { strength: 1.42 }
      );
      controls = applyAgentFaceRuntimeDragToControls({ drag: descriptor.drag }, controls);
      controls = applySpeechToControls(controls, descriptor.speech);
      controls = applyToneToControls(controls, descriptor.tone);
      applyControlsToRig(entry.rig, controls);

      renderer.setViewport(viewportLeft, y, viewportWidth, viewportHeight);
      renderer.setScissor(viewportLeft, y, viewportWidth, viewportHeight);
      renderer.clearDepth();
      renderer.render(entry.scene, entry.camera);
    }
  }

  function dispose() {
    for (const entry of entries.values()) {
      entry.scene.remove(entry.backdrop);
      entry.backdrop.geometry.dispose();
      entry.backdrop.material.dispose();
      entry.scene.remove(entry.rig.root);
      disposeFaceRig(entry.rig);
    }
    entries.clear();
    renderer.dispose();
  }

  return {
    render,
    dispose
  };
}
