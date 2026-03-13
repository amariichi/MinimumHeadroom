import * as THREE from 'three';
import { DEFAULT_FACE_APPEARANCE } from './face_appearance_defaults.js';
import { FEATURE_ANCHORS } from './state_engine.js';

export const FACE_ROOT_BASE_Y = 0.56;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function enforceSideX(value, side) {
  if (side === 'left') {
    return Math.min(value, -0.08);
  }
  return Math.max(value, 0.08);
}

function enforceFrontZ(value) {
  return Math.max(1.01, value);
}

const sharedAssets = Object.freeze({
  neckGeometry: new THREE.CylinderGeometry(0.26, 0.31, 0.78, 18),
  headGeometry: new THREE.SphereGeometry(1, 52, 38),
  hairGeometry: new THREE.SphereGeometry(0.9, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.44),
  browGeometry: new THREE.BoxGeometry(0.68, 0.11, 0.1),
  eyeWhiteGeometry: new THREE.SphereGeometry(0.25, 28, 20),
  pupilGeometry: new THREE.SphereGeometry(0.094, 20, 16),
  noseGeometry: new THREE.ConeGeometry(0.14, 0.36, 4),
  mouthOuterGeometry: new THREE.BoxGeometry(0.62, 0.13, 0.12),
  mouthInnerGeometry: new THREE.BoxGeometry(0.5, 0.09, 0.1)
});

export function createFaceAppearance(input = {}) {
  return {
    ...DEFAULT_FACE_APPEARANCE,
    ...input
  };
}

function createFaceMaterials(appearance) {
  return {
    skin: new THREE.MeshStandardMaterial({ color: appearance.skin, roughness: 0.56, metalness: 0.06 }),
    hair: new THREE.MeshStandardMaterial({
      color: appearance.hair,
      roughness: 0.72,
      metalness: 0.02,
      emissive: appearance.hair,
      emissiveIntensity: 0
    }),
    brow: new THREE.MeshStandardMaterial({
      color: appearance.brow,
      roughness: 0.84,
      metalness: 0,
      emissive: appearance.brow,
      emissiveIntensity: 0
    }),
    eyeWhite: new THREE.MeshStandardMaterial({ color: appearance.eyeWhite, roughness: 0.2, metalness: 0 }),
    pupil: new THREE.MeshStandardMaterial({ color: appearance.pupil, roughness: 0.4, metalness: 0.04 }),
    nose: new THREE.MeshStandardMaterial({ color: appearance.nose, roughness: 0.58, metalness: 0.05 }),
    mouthOuter: new THREE.MeshStandardMaterial({ color: appearance.mouthOuter, roughness: 0.66, metalness: 0.02 }),
    mouthInner: new THREE.MeshStandardMaterial({ color: appearance.mouthInner, roughness: 0.36, metalness: 0.02 })
  };
}

export function createFaceRig(scene, options = {}) {
  const appearance = createFaceAppearance(options.appearance);
  const root = new THREE.Group();
  root.position.set(0, FACE_ROOT_BASE_Y, 0);
  root.scale.setScalar(appearance.rootScale);
  scene.add(root);

  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, -0.35, 0);
  root.add(neckPivot);

  const materials = createFaceMaterials(appearance);

  const neck = new THREE.Mesh(sharedAssets.neckGeometry, materials.skin);
  neck.position.set(FEATURE_ANCHORS.neck.x, FEATURE_ANCHORS.neck.y + 0.28, FEATURE_ANCHORS.neck.z - 0.08);
  neck.renderOrder = 1;
  root.add(neck);

  const head = new THREE.Mesh(sharedAssets.headGeometry, materials.skin);
  head.position.set(0, 0.16, 0);
  head.renderOrder = 2;
  neckPivot.add(head);

  const hair = new THREE.Mesh(sharedAssets.hairGeometry, materials.hair);
  hair.renderOrder = 3;
  neckPivot.add(hair);

  const browLeft = new THREE.Mesh(sharedAssets.browGeometry, materials.brow);
  const browRight = new THREE.Mesh(sharedAssets.browGeometry, materials.brow);
  browLeft.renderOrder = 4;
  browRight.renderOrder = 4;
  neckPivot.add(browLeft);
  neckPivot.add(browRight);

  const eyeWhiteLeft = new THREE.Mesh(sharedAssets.eyeWhiteGeometry, materials.eyeWhite);
  const eyeWhiteRight = new THREE.Mesh(sharedAssets.eyeWhiteGeometry, materials.eyeWhite);
  const pupilLeft = new THREE.Mesh(sharedAssets.pupilGeometry, materials.pupil);
  const pupilRight = new THREE.Mesh(sharedAssets.pupilGeometry, materials.pupil);
  eyeWhiteLeft.renderOrder = 5;
  eyeWhiteRight.renderOrder = 5;
  pupilLeft.renderOrder = 6;
  pupilRight.renderOrder = 6;
  neckPivot.add(eyeWhiteLeft);
  neckPivot.add(eyeWhiteRight);
  neckPivot.add(pupilLeft);
  neckPivot.add(pupilRight);

  const nose = new THREE.Mesh(sharedAssets.noseGeometry, materials.nose);
  nose.rotation.x = Math.PI / 2;
  nose.renderOrder = 6;
  neckPivot.add(nose);

  const mouthOuter = new THREE.Mesh(sharedAssets.mouthOuterGeometry, materials.mouthOuter);
  const mouthInner = new THREE.Mesh(sharedAssets.mouthInnerGeometry, materials.mouthInner);
  mouthOuter.renderOrder = 6;
  mouthInner.renderOrder = 7;
  neckPivot.add(mouthOuter);
  neckPivot.add(mouthInner);

  const rig = {
    appearance,
    materials,
    root,
    neckPivot,
    neck,
    head,
    hair,
    browLeft,
    browRight,
    eyeWhiteLeft,
    eyeWhiteRight,
    pupilLeft,
    pupilRight,
    nose,
    mouthOuter,
    mouthInner
  };

  applyAppearanceToRig(rig, appearance);
  return rig;
}

export function applyAppearanceToRig(rig, input = {}) {
  const appearance = createFaceAppearance(input);
  rig.appearance = appearance;
  rig.root.scale.setScalar(appearance.rootScale);
  rig.head.scale.set(appearance.headScaleX, appearance.headScaleY, appearance.headScaleZ);
  rig.hair.scale.set(appearance.hairScaleX, appearance.hairScaleY, appearance.hairScaleZ);
  rig.hair.position.set(0, appearance.hairLift, appearance.hairOffsetZ);
  rig.eyeWhiteLeft.scale.set(appearance.eyeWidth, 1, appearance.eyeDepth);
  rig.eyeWhiteRight.scale.set(appearance.eyeWidth, 1, appearance.eyeDepth);

  rig.materials.skin.color.setHex(appearance.skin);
  rig.materials.hair.color.setHex(appearance.hair);
  rig.materials.brow.color.setHex(appearance.brow);
  rig.materials.eyeWhite.color.setHex(appearance.eyeWhite);
  rig.materials.pupil.color.setHex(appearance.pupil);
  rig.materials.nose.color.setHex(appearance.nose);
  rig.materials.mouthOuter.color.setHex(appearance.mouthOuter);
  rig.materials.mouthInner.color.setHex(appearance.mouthInner);
  rig.materials.hair.emissive.setHex(appearance.hair);
  rig.materials.brow.emissive.setHex(appearance.brow);
}

export function disposeFaceRig(rig) {
  if (!rig?.materials) {
    return;
  }
  for (const material of Object.values(rig.materials)) {
    material.dispose();
  }
}

export function addFaceLights(scene, options = {}) {
  const ambientLight = new THREE.AmbientLight(options.ambientColor ?? 0xd8ecff, options.ambientIntensity ?? 0.64);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(options.keyColor ?? 0xfff2df, options.keyIntensity ?? 0.95);
  keyLight.position.set(2.8, 2.7, 3.8);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(options.fillColor ?? 0x8ac9ff, options.fillIntensity ?? 0.5);
  fillLight.position.set(-2.4, 0.4, 2.8);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(options.rimColor ?? 0xff8f58, options.rimIntensity ?? 0.34);
  rimLight.position.set(0.7, 2.2, -2.5);
  scene.add(rimLight);

  return { ambientLight, keyLight, fillLight, rimLight };
}

export function createFaceCamera(options = {}) {
  const camera = new THREE.PerspectiveCamera(options.fov ?? 35, options.aspect ?? 1, 0.1, options.far ?? 35);
  camera.position.set(options.x ?? 0, options.y ?? 0.1, options.z ?? 5.55);
  camera.lookAt(options.lookAtX ?? 0, options.lookAtY ?? 0.3, options.lookAtZ ?? 0);
  return camera;
}

export function applyControlsToRig(rig, controls) {
  const appearance = rig.appearance ?? DEFAULT_FACE_APPEARANCE;
  const swayX = clamp(controls.head.sway_x ?? controls.head.yaw * 0.5, -1, 1);
  const swayY = clamp(controls.head.sway_y ?? controls.head.pitch * 0.5, -1, 1);
  const pushZ = clamp(controls.head.push_z ?? 0, -1, 1);

  rig.root.position.set(swayX * 0.2, FACE_ROOT_BASE_Y + swayY * 0.33, pushZ * 0.12);
  rig.root.rotation.y = controls.head.yaw * 0.08;

  rig.neckPivot.rotation.y = controls.head.yaw * ((28 * Math.PI) / 180);
  rig.neckPivot.rotation.x = controls.head.pitch * ((38 * Math.PI) / 180);
  rig.neckPivot.rotation.z = controls.head.roll * ((23 * Math.PI) / 180);

  const furrowOffset = controls.brows.furrow * 0.14;
  const browTilt = controls.brows.tilt;
  const browScaleBase = (1.08 + controls.brows.furrow * 0.2) * appearance.browWidth;
  const browThickness = 1 - controls.brows.furrow * 0.12;
  const browZ = enforceFrontZ(FEATURE_ANCHORS.brow_l.z + 0.03 + controls.brows.furrow * 0.03);

  rig.browLeft.position.set(
    enforceSideX(FEATURE_ANCHORS.brow_l.x + furrowOffset, 'left'),
    FEATURE_ANCHORS.brow_l.y + (controls.brows.left.raise - 0.5) * 0.46,
    browZ
  );
  rig.browRight.position.set(
    enforceSideX(FEATURE_ANCHORS.brow_r.x - furrowOffset, 'right'),
    FEATURE_ANCHORS.brow_r.y + (controls.brows.right.raise - 0.5) * 0.46,
    browZ
  );
  rig.browLeft.rotation.z = browTilt * 0.56;
  rig.browRight.rotation.z = -browTilt * 0.56;
  rig.browLeft.scale.set(browScaleBase, browThickness, 1);
  rig.browRight.scale.set(browScaleBase, browThickness, 1);

  const eyeOpenLeft = clamp(controls.eyes.left.open, 0.02, 1);
  const eyeOpenRight = clamp(controls.eyes.right.open, 0.02, 1);
  const eyeLeftX = enforceSideX(FEATURE_ANCHORS.eye_l.x + controls.eyes.gaze_x * 0.04, 'left');
  const eyeRightX = enforceSideX(FEATURE_ANCHORS.eye_r.x + controls.eyes.gaze_x * 0.04, 'right');
  const eyeY = FEATURE_ANCHORS.eye_l.y + controls.eyes.gaze_y * 0.045;
  const eyeZ = enforceFrontZ(FEATURE_ANCHORS.eye_l.z + controls.brows.furrow * 0.01);

  rig.eyeWhiteLeft.position.set(eyeLeftX, eyeY, eyeZ);
  rig.eyeWhiteRight.position.set(eyeRightX, eyeY, eyeZ);
  rig.eyeWhiteLeft.scale.set(appearance.eyeWidth, Math.max(0.02, eyeOpenLeft), appearance.eyeDepth);
  rig.eyeWhiteRight.scale.set(appearance.eyeWidth, Math.max(0.02, eyeOpenRight), appearance.eyeDepth);

  const pupilYOffset = controls.eyes.gaze_y * 0.08;
  const pupilZ = enforceFrontZ(FEATURE_ANCHORS.eye_l.z + 0.19);
  rig.pupilLeft.position.set(eyeLeftX + controls.eyes.gaze_x * 0.11, eyeY + pupilYOffset, pupilZ);
  rig.pupilRight.position.set(eyeRightX + controls.eyes.gaze_x * 0.11, eyeY + pupilYOffset, pupilZ);

  rig.nose.position.set(
    FEATURE_ANCHORS.nose.x,
    FEATURE_ANCHORS.nose.y + controls.eyes.gaze_y * 0.03,
    enforceFrontZ(FEATURE_ANCHORS.nose.z)
  );

  const mouthOpen = clamp(controls.mouth.open, 0, 1);
  const mouthWide = clamp(controls.mouth.wide, 0, 1);
  rig.mouthOuter.position.set(
    FEATURE_ANCHORS.mouth.x,
    FEATURE_ANCHORS.mouth.y - mouthOpen * 0.03,
    enforceFrontZ(FEATURE_ANCHORS.mouth.z)
  );
  rig.mouthInner.position.set(
    FEATURE_ANCHORS.mouth.x,
    FEATURE_ANCHORS.mouth.y + 0.01 - mouthOpen * 0.045,
    enforceFrontZ(FEATURE_ANCHORS.mouth.z + 0.02)
  );
  rig.mouthOuter.scale.set(0.86 + mouthWide * 0.78, 0.26 + mouthOpen * 2.12, 1);
  rig.mouthInner.scale.set(0.78 + mouthWide * 0.68, 0.16 + mouthOpen * 1.94, 1);
  rig.hair.position.set(0, appearance.hairLift + controls.debug.jank * 0.016, appearance.hairOffsetZ);
}
