import { DEFAULT_FACE_APPEARANCE } from './face_appearance_defaults.js';
import { createFaceIdleMotionProfile } from './face_idle_motion.js';

const SKIN_PALETTES = Object.freeze([
  { skin: 0xc9905a, nose: 0x8e5933, mouthInner: 0xe37f62 },
  { skin: 0xe2b78a, nose: 0xb88356, mouthInner: 0xf29a84 },
  { skin: 0xa96f44, nose: 0x734727, mouthInner: 0xd67663 },
  { skin: 0x9d6942, nose: 0x6f4728, mouthInner: 0xd78069 },
  { skin: 0xf0d4b8, nose: 0xc39973, mouthInner: 0xf3b0a1 },
  { skin: 0x6f4a33, nose: 0x4b2d1c, mouthInner: 0xc56a59 }
]);

const HAIR_PALETTES = Object.freeze([
  { hair: 0x2c1d16, brow: 0x1a110c, accent: '#8d5b43' },
  { hair: 0xf2c431, brow: 0xa06f08, accent: '#ffd85e' },
  { hair: 0x2d6fff, brow: 0x143b91, accent: '#6aa6ff' },
  { hair: 0x8a4dff, brow: 0x5020a7, accent: '#c3a3ff' },
  { hair: 0x16bf6d, brow: 0x0f7442, accent: '#57e29c' },
  { hair: 0xf05f31, brow: 0x9b3113, accent: '#ff9b73' }
]);

function hashString(value) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'agent';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(list, seed, shift = 0) {
  return list[(seed + shift) % list.length];
}

function mix(base, delta) {
  return base + delta;
}

function toCssColor(hexValue) {
  return `#${hexValue.toString(16).padStart(6, '0')}`;
}

export function deriveAgentFaceIdentity(agent = {}) {
  const id = typeof agent?.id === 'string' && agent.id.trim() !== '' ? agent.id.trim() : 'agent';
  if (id === '__operator__') {
    return {
      seed: 'operator',
      accent: '#7bf5b8',
      motion: createFaceIdleMotionProfile('operator'),
      appearance: {
        ...DEFAULT_FACE_APPEARANCE,
        rootScale: 0.82,
        hair: 0x2c1d16,
        brow: 0x1a110c,
        skin: 0xc9905a,
        nose: 0x8e5933,
        mouthInner: 0xe37f62
      }
    };
  }

  const sessionId = typeof agent?.session_id === 'string' && agent.session_id.trim() !== '' ? agent.session_id.trim() : '';
  const seedText = sessionId !== '' ? `${id}:${sessionId}` : id;
  const seed = hashString(seedText);
  const skin = pick(SKIN_PALETTES, seed);
  const hair = pick(HAIR_PALETTES, seed >>> 3, 1);
  const tallFactor = ((seed >>> 5) % 17) / 100;
  const widthFactor = ((seed >>> 9) % 15) / 100;
  const eyeFactor = ((seed >>> 13) % 15) / 100;
  const hairLiftFactor = ((seed >>> 17) % 12) / 100;
  const browFactor = ((seed >>> 21) % 10) / 100;

  return {
    seed: seedText,
    accent: hair.accent,
    motion: createFaceIdleMotionProfile(seedText),
    appearance: {
      ...DEFAULT_FACE_APPEARANCE,
      skin: skin.skin,
      nose: skin.nose,
      mouthInner: skin.mouthInner,
      hair: hair.hair,
      brow: hair.brow,
      mouthOuter: mix(DEFAULT_FACE_APPEARANCE.mouthOuter, 0),
      rootScale: 0.77 + widthFactor * 0.2,
      headScaleX: 1.18 + widthFactor * 0.85,
      headScaleY: 1.33 + tallFactor * 1.15,
      headScaleZ: 1.03 + widthFactor * 0.48,
      hairScaleX: 1.0 + widthFactor * 0.58,
      hairScaleY: 0.5 + tallFactor * 0.45,
      hairScaleZ: 0.84 + widthFactor * 0.42,
      hairLift: 1.02 + hairLiftFactor,
      browWidth: 0.94 + browFactor,
      eyeWidth: 1.34 + eyeFactor,
      eyeDepth: 0.76 + widthFactor * 0.25
    }
  };
}

export function faceAccentCss(identity) {
  if (typeof identity?.accent === 'string' && identity.accent.trim() !== '') {
    return identity.accent;
  }
  return toCssColor(DEFAULT_FACE_APPEARANCE.hair);
}
