import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { VoyageFrameState } from './voyageChoreography';
import { clamp } from './voyageChoreography';

export type YachtCalloutKey = 'hierarchy' | 'shell' | 'system' | 'motion';

export interface ProjectedYachtAnchor {
  xPct: number;
  yPct: number;
  visible: boolean;
}

export type YachtAnchorProjectionMap = Record<YachtCalloutKey, ProjectedYachtAnchor>;

export interface CircleFormation3DHandle {
  updateAndRender: (
    state: VoyageFrameState,
    effectiveAlpha: number,
    elapsedTimeSec: number,
    theme: 'light' | 'dark',
    viewportWidth: number,
    viewportHeight: number
  ) => YachtAnchorProjectionMap | null;
  clearCanvas: () => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
  domElement: HTMLCanvasElement;
}

// Reusable math scratch objects (zero per-frame allocations)
const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _projVec = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) return true;
  const ext = probe.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
  const gpu = String(probe.getParameter(param));
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
}

/**
 * Creates a procedural Burmese teak deck planking texture with caulked dark seams.
 */
function createTeakTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#9b6b3e';
    ctx.fillRect(0, 0, w, h);

    const plankCount = 14;
    const plankW = w / plankCount;
    for (let i = 0; i < plankCount; i++) {
      const shade = ((i * 37) % 19) - 9;
      ctx.fillStyle = `rgb(${156 + shade}, ${106 + Math.round(shade * 0.7)}, ${62 + Math.round(shade * 0.4)})`;
      ctx.fillRect(i * plankW + 2, 0, plankW - 3, h);

      // Subtle wood grain streaks
      ctx.fillStyle = 'rgba(72, 42, 18, 0.14)';
      for (let g = 0; g < 6; g++) {
        const gx = i * plankW + 4 + ((g * 7 + i * 3) % Math.max(4, Math.floor(plankW - 8)));
        ctx.fillRect(gx, 0, 1.5, h);
      }

      // Black marine caulk seam
      ctx.fillStyle = '#24180e';
      ctx.fillRect(i * plankW, 0, 2, h);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.5, 5);
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates an indexed, strictly manifold lofted geometry across symmetric yacht hull cross-sections.
 * Winding is verified outward CCW on starboard (+X), keel (-Y), and port (-X).
 */
interface HullStation {
  z: number;
  sheerX: number;
  sheerY: number;
  chineX: number;
  chineY: number;
  keelY: number;
}

function createHullStations(): HullStation[] {
  // 14 smooth lofted stations from stern (-5.15) to sharp V-bow stem (+6.08) for fluid sphere morphing
  return [
    { z: -5.15, sheerX: 1.54, sheerY: 0.96, chineX: 1.38, chineY: 0.14, keelY: -0.46 },
    { z: -4.45, sheerX: 1.57, sheerY: 0.97, chineX: 1.41, chineY: 0.12, keelY: -0.51 },
    { z: -3.55, sheerX: 1.60, sheerY: 0.98, chineX: 1.44, chineY: 0.11, keelY: -0.56 },
    { z: -2.45, sheerX: 1.63, sheerY: 1.01, chineX: 1.45, chineY: 0.09, keelY: -0.62 },
    { z: -1.25, sheerX: 1.64, sheerY: 1.04, chineX: 1.44, chineY: 0.08, keelY: -0.68 },
    { z: -0.10, sheerX: 1.62, sheerY: 1.07, chineX: 1.41, chineY: 0.08, keelY: -0.72 },
    { z: 0.95, sheerX: 1.57, sheerY: 1.12, chineX: 1.32, chineY: 0.08, keelY: -0.75 },
    { z: 1.95, sheerX: 1.48, sheerY: 1.17, chineX: 1.20, chineY: 0.10, keelY: -0.76 },
    { z: 2.90, sheerX: 1.33, sheerY: 1.23, chineX: 1.01, chineY: 0.12, keelY: -0.74 },
    { z: 3.75, sheerX: 1.10, sheerY: 1.29, chineX: 0.75, chineY: 0.15, keelY: -0.68 },
    { z: 4.55, sheerX: 0.80, sheerY: 1.36, chineX: 0.46, chineY: 0.21, keelY: -0.55 },
    { z: 5.20, sheerX: 0.46, sheerY: 1.43, chineX: 0.22, chineY: 0.31, keelY: -0.30 },
    { z: 5.70, sheerX: 0.18, sheerY: 1.48, chineX: 0.08, chineY: 0.45, keelY: -0.04 },
    { z: 6.08, sheerX: 0.025, sheerY: 1.53, chineX: 0.015, chineY: 0.72, keelY: 0.28 },
  ];
}

function buildLoftedHullBandGeometry(
  stations: HullStation[],
  band: 'lower' | 'upper'
): THREE.BufferGeometry {
  // Lower band covers keel (-Y) up to waterline (+0.16)
  // Upper band covers waterline (+0.14) up to flared deck sheer (sheerY)
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const profileCount = band === 'lower' ? 7 : 7;
  const rows = stations.length;

  for (let s = 0; s < rows; s++) {
    const st = stations[s];
    const v = s / (rows - 1);

    let pts: [number, number][];
    if (band === 'lower') {
      const wlX = st.chineX + (st.sheerX - st.chineX) * 0.04;
      const wlY = Math.max(st.chineY + 0.01, 0.135);
      const midChineX = st.chineX * 0.56;
      const midKeelY = st.keelY * 0.72 + st.chineY * 0.28;
      pts = [
        [wlX, wlY],
        [st.chineX, st.chineY],
        [midChineX, midKeelY],
        [0, st.keelY],
        [-midChineX, midKeelY],
        [-st.chineX, st.chineY],
        [-wlX, wlY],
      ];
    } else {
      const wlX = st.chineX + (st.sheerX - st.chineX) * 0.06;
      const wlY = Math.max(st.chineY + 0.02, 0.145);
      const midX = (wlX + st.sheerX) * 0.52;
      const midY = (wlY + st.sheerY) * 0.50;
      const upperX = st.sheerX * 0.94;
      pts = [
        [upperX, st.sheerY],
        [st.sheerX, st.sheerY - 0.04],
        [midX, midY],
        [wlX, wlY],
        [-wlX, wlY],
        [-midX, midY],
        [-st.sheerX, st.sheerY - 0.04],
      ];
      void pts;
    }

    if (band === 'lower') {
      for (let i = 0; i < profileCount; i++) {
        positions.push(pts![i][0], pts![i][1], st.z);
        uvs.push(i / (profileCount - 1), v);
      }
    }
  }

  if (band === 'lower') {
    for (let s = 0; s < rows - 1; s++) {
      for (let i = 0; i < profileCount - 1; i++) {
        const a = s * profileCount + i;
        const b = s * profileCount + (i + 1);
        const c = (s + 1) * profileCount + (i + 1);
        const d = (s + 1) * profileCount + i;
        indices.push(a, d, c, a, c, b);
      }
    }

    // Close flat stern transom at station 0
    const s0 = stations[0];
    const wlY0 = Math.max(s0.chineY + 0.01, 0.135);
    const transomCenterIdx = positions.length / 3;
    positions.push(0, (wlY0 + s0.keelY) * 0.5, s0.z);
    uvs.push(0.5, 0);
    for (let i = 0; i < profileCount - 1; i++) {
      indices.push(transomCenterIdx, i, i + 1);
    }
    indices.push(transomCenterIdx, profileCount - 1, 0);

    // Close bow stem tip at station rows - 1
    const lastBase = (rows - 1) * profileCount;
    const bowCenterIdx = positions.length / 3;
    const sBow = stations[rows - 1];
    positions.push(0, (sBow.chineY + sBow.keelY) * 0.5, sBow.z + 0.01);
    uvs.push(0.5, 1);
    for (let i = 0; i < profileCount - 1; i++) {
      indices.push(bowCenterIdx, lastBase + i + 1, lastBase + i);
    }
    indices.push(bowCenterIdx, lastBase, lastBase + profileCount - 1);
  } else {
    // Upper band: separate starboard (+X), port (-X), and flat fore/side deck surface so zero internal triangles cut across!
    const sidePts = 4; // [sheerTopIn, sheerOuter, midFlank, waterlineEdge]
    const buildFlank = (sign: 1 | -1) => {
      const baseVertex = positions.length / 3;
      for (let s = 0; s < rows; s++) {
        const st = stations[s];
        const v = s / (rows - 1);
        const wlX = (st.chineX + (st.sheerX - st.chineX) * 0.06) * sign;
        const wlY = Math.max(st.chineY + 0.02, 0.145);
        const midX = ((st.chineX + st.sheerX) * 0.52) * sign;
        const midY = (wlY + st.sheerY) * 0.52;
        const sheerX = st.sheerX * sign;
        const deckEdgeX = st.sheerX * 0.92 * sign;

        const curve: [number, number][] =
          sign === 1
            ? [
                [deckEdgeX, st.sheerY],
                [sheerX, st.sheerY - 0.03],
                [midX, midY],
                [wlX, wlY],
              ]
            : [
                [wlX, wlY],
                [midX, midY],
                [sheerX, st.sheerY - 0.03],
                [deckEdgeX, st.sheerY],
              ];

        for (let i = 0; i < sidePts; i++) {
          positions.push(curve[i][0], curve[i][1], st.z);
          uvs.push(i / (sidePts - 1), v);
        }
      }
      for (let s = 0; s < rows - 1; s++) {
        for (let i = 0; i < sidePts - 1; i++) {
          const a = baseVertex + s * sidePts + i;
          const b = baseVertex + s * sidePts + (i + 1);
          const c = baseVertex + (s + 1) * sidePts + (i + 1);
          const d = baseVertex + (s + 1) * sidePts + i;
          indices.push(a, d, c, a, c, b);
        }
      }
    };

    buildFlank(1);
    buildFlank(-1);

    // Full white main deck top sheet spanning port sheer -> starboard sheer
    const deckBase = positions.length / 3;
    for (let s = 0; s < rows; s++) {
      const st = stations[s];
      const v = s / (rows - 1);
      positions.push(-st.sheerX * 0.92, st.sheerY, st.z);
      uvs.push(0, v);
      positions.push(0, st.sheerY + 0.03, st.z);
      uvs.push(0.5, v);
      positions.push(st.sheerX * 0.92, st.sheerY, st.z);
      uvs.push(1, v);
    }
    for (let s = 0; s < rows - 1; s++) {
      for (let i = 0; i < 2; i++) {
        const a = deckBase + s * 3 + i;
        const b = deckBase + s * 3 + i + 1;
        const c = deckBase + (s + 1) * 3 + i + 1;
        const d = deckBase + (s + 1) * 3 + i;
        // Normal points +Y: (A->D = +Z), (A->B = +X), (+Z) x (+X) = +Y!
        indices.push(a, d, c, a, c, b);
      }
    }

    // Solid white transom bulkhead at stern (z = -5.15)
    const s0 = stations[0];
    const wlY0 = Math.max(s0.chineY + 0.02, 0.14);
    const wlX0 = s0.chineX + (s0.sheerX - s0.chineX) * 0.06;
    const tBase = positions.length / 3;
    positions.push(
      -wlX0, wlY0, s0.z,
      wlX0, wlY0, s0.z,
      s0.sheerX, s0.sheerY - 0.03, s0.z,
      -s0.sheerX, s0.sheerY - 0.03, s0.z
    );
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    // Normal points -Z: (0->2 = +X,+Y), (0->1 = +X) => Wait: (+X) x (+Y) = +Z, so reverse to (0, 3, 2, 0, 2, 1)!
    indices.push(tBase, tBase + 3, tBase + 2, tBase, tBase + 2, tBase + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds the entire sculptural composite 3D Luxury Motor Yacht matching the turnaround sheet.
 */
function buildLuxuryYachtGroup(
  teakTex: THREE.CanvasTexture,
  trackGeo: <T extends THREE.BufferGeometry>(g: T) => T,
  trackMat: <T extends THREE.Material>(m: T) => T
) {
  const yacht = new THREE.Group();
  const hullGroup = new THREE.Group();
  const deckGroup = new THREE.Group();
  const cabinGroup = new THREE.Group();
  const mastGroup = new THREE.Group();
  const propulsionGroup = new THREE.Group();
  yacht.add(propulsionGroup, hullGroup, deckGroup, cabinGroup, mastGroup);

  const fadeableMaterials: {
    mat: THREE.Material;
    baseOpacity: number;
    alwaysTransparent: boolean;
  }[] = [];
  const propellers: THREE.Object3D[] = [];
  let radarBarMesh: THREE.Mesh | null = null;

  const registerMat = <T extends THREE.Material>(mat: T, baseOpacity = 1): T => {
    const alwaysTransparent = baseOpacity < 1;
    mat.transparent = alwaysTransparent;
    mat.opacity = baseOpacity;
    fadeableMaterials.push({ mat, baseOpacity, alwaysTransparent });
    return trackMat(mat);
  };

  // Materials calibrated for distinct yacht silhouettes & PBR light response
  const gelcoatWhiteMat = registerMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xf4f7fc,
      roughness: 0.14,
      metalness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.25,
    })
  );

  const superWhiteMat = registerMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xf8fafc,
      roughness: 0.18,
      metalness: 0.04,
      clearcoat: 0.85,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.1,
    })
  );

  const lowerKeelMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0x131926,
      roughness: 0.42,
      metalness: 0.14,
      envMapIntensity: 0.9,
    })
  );

  const blackTrimMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0x0b0f18,
      roughness: 0.3,
      metalness: 0.25,
    })
  );

  const tintedGlassMat = registerMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x09162d,
      roughness: 0.06,
      metalness: 0.12,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    0.58
  );

  const teakMat = registerMat(
    new THREE.MeshStandardMaterial({
      map: teakTex,
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.02,
      envMapIntensity: 0.65,
    })
  );

  const stainlessMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0xe6edf6,
      roughness: 0.14,
      metalness: 0.92,
      envMapIntensity: 1.4,
    })
  );

  const bronzePropMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0xc48b45,
      roughness: 0.24,
      metalness: 0.88,
      envMapIntensity: 1.35,
    })
  );

  const creamUpholsteryMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0xebe8e1,
      roughness: 0.72,
      metalness: 0.02,
    })
  );

  const helmDisplayMat = registerMat(
    new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: new THREE.Color(0x38bdf8),
      emissiveIntensity: 0.75,
      roughness: 0.2,
    })
  );

  // 1. Primary Hull: Lower Dark Anti-Fouling Hull (Propulsion/Keel) + Upper Flared White Hull + Waterline Boot Stripe
  const stations = createHullStations();
  const lowerHull = new THREE.Mesh(
    trackGeo(buildLoftedHullBandGeometry(stations, 'lower')),
    lowerKeelMat
  );
  const upperHull = new THREE.Mesh(
    trackGeo(buildLoftedHullBandGeometry(stations, 'upper')),
    gelcoatWhiteMat
  );
  propulsionGroup.add(lowerHull);
  hullGroup.add(upperHull);

  // Black Boot-Top Accent Stripe flanking waterline
  for (const sign of [-1, 1] as const) {
    const bootPts = stations.map(
      (st) =>
        new THREE.Vector3(
          (st.chineX + (st.sheerX - st.chineX) * 0.075 + 0.015) * sign,
          Math.max(st.chineY + 0.03, 0.155),
          st.z
        )
    );
    const bootCurve = new THREE.CatmullRomCurve3(bootPts);
    const bootMesh = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(bootCurve, 40, 0.026, 8, false)),
      blackTrimMat
    );
    hullGroup.add(bootMesh);
  }

  // 2. Stepped Teak Aft Swim Platform + Aft Cockpit Deck + Foredeck Sunpad
  const swimPlatformShape = new THREE.Shape();
  swimPlatformShape.moveTo(-1.38, -0.45);
  swimPlatformShape.lineTo(1.38, -0.45);
  swimPlatformShape.quadraticCurveTo(1.42, 0.35, 1.1, 0.48);
  swimPlatformShape.lineTo(-1.1, 0.48);
  swimPlatformShape.quadraticCurveTo(-1.42, 0.35, -1.38, -0.45);

  const swimPlatformGeo = trackGeo(
    new THREE.ExtrudeGeometry(swimPlatformShape, {
      depth: 0.10,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.025,
      bevelSegments: 2,
    })
  );
  swimPlatformGeo.rotateX(Math.PI / 2);
  const swimPlatform = new THREE.Mesh(swimPlatformGeo, teakMat);
  swimPlatform.position.set(0, 0.28, -5.5);
  deckGroup.add(swimPlatform);

  // White transom swim platform surround rim (cleanly below teak top so zero z-fighting)
  const swimRim = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.88, 0.10, 0.98, 8, 1, 4)),
    gelcoatWhiteMat
  );
  swimRim.position.set(0, 0.11, -5.45);
  deckGroup.add(swimRim);

  // Aft Cockpit Teak Sole
  const cockpitTeak = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.45, 0.04, 2.35, 8, 1, 8)),
    teakMat
  );
  cockpitTeak.position.set(0, 1.02, -3.72);
  deckGroup.add(cockpitTeak);

  // Foredeck Teak Center Accent & Cushion Sunpad (cleanly elevated above white foredeck)
  const foredeckTeakShape = new THREE.Shape();
  foredeckTeakShape.moveTo(-0.34, -0.78);
  foredeckTeakShape.lineTo(0.34, -0.78);
  foredeckTeakShape.lineTo(0.11, 0.78);
  foredeckTeakShape.lineTo(-0.11, 0.78);
  foredeckTeakShape.closePath();

  const foredeckTeakGeo = trackGeo(
    new THREE.ExtrudeGeometry(foredeckTeakShape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.01,
      bevelSegments: 1,
    })
  );
  foredeckTeakGeo.rotateX(Math.PI / 2);
  const foredeckTeak = new THREE.Mesh(foredeckTeakGeo, teakMat);
  foredeckTeak.rotation.x = -0.085;
  foredeckTeak.position.set(0, 1.46, 4.65);
  deckGroup.add(foredeckTeak);

  const sunpadGeo = trackGeo(new THREE.BoxGeometry(1.52, 0.12, 1.55, 6, 1, 6));
  const sunpad = new THREE.Mesh(sunpadGeo, creamUpholsteryMat);
  sunpad.rotation.x = -0.07;
  sunpad.position.set(0, 1.38, 3.15);
  deckGroup.add(sunpad);

  // 3. Flush Stainless Bow Scuff-Plate + 4 Calibrated Hull Oval Portholes per side (no coplanar z-fighting)
  const bowGuardGeo = trackGeo(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 10, 4));
  const portholeGeo = trackGeo(new THREE.CylinderGeometry(0.105, 0.105, 0.05, 16, 1));
  portholeGeo.rotateZ(Math.PI / 2);

  const bowStemGuard = new THREE.Mesh(bowGuardGeo, stainlessMat);
  bowStemGuard.position.set(0, 1.05, 5.92);
  bowStemGuard.rotation.x = -0.45;
  hullGroup.add(bowStemGuard);

  for (const sign of [-1, 1] as const) {
    const portholeZs = [3.15, 1.92, 0.72, -0.52];
    const portholeYs = [0.76, 0.72, 0.68, 0.65];
    const portholeXs = [1.13, 1.41, 1.55, 1.58];
    portholeZs.forEach((pz, idx) => {
      const portMesh = new THREE.Mesh(portholeGeo, blackTrimMat);
      portMesh.scale.set(1, 0.66, 1.62);
      portMesh.position.set(portholeXs[idx] * sign, portholeYs[idx], pz);
      portMesh.rotation.y = -0.18 * sign * (idx === 0 ? 1.4 : 0.4);
      hullGroup.add(portMesh);
    });
  }

  // 4. Sculpted Main Cabin Superstructure & Curved Side Buttresses (ExtrudeGeometry)
  const sideArchShape = new THREE.Shape();
  sideArchShape.moveTo(-2.75, 0.98);
  sideArchShape.lineTo(-2.35, 1.02);
  sideArchShape.lineTo(-2.15, 1.96);
  sideArchShape.lineTo(-3.45, 2.08);
  sideArchShape.quadraticCurveTo(-3.65, 2.15, -3.52, 2.26);
  sideArchShape.lineTo(1.75, 2.26);
  sideArchShape.quadraticCurveTo(2.45, 1.75, 2.55, 1.26);
  sideArchShape.lineTo(1.95, 1.20);
  sideArchShape.quadraticCurveTo(1.85, 1.75, 1.15, 2.02);
  sideArchShape.lineTo(-2.28, 2.02);
  sideArchShape.lineTo(-2.75, 0.98);

  const sideArchGeo = trackGeo(
    new THREE.ExtrudeGeometry(sideArchShape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 2,
      curveSegments: 14,
    })
  );
  sideArchGeo.rotateY(-Math.PI / 2);

  for (const sign of [-1, 1] as const) {
    const buttress = new THREE.Mesh(sideArchGeo, superWhiteMat);
    buttress.position.set((sign === 1 ? 1.28 : -1.14), 0, 0);
    cabinGroup.add(buttress);
  }

  // Main Cabin Sweeping Translucent Smoked Glass Wrap
  const salonWindowGeo = trackGeo(new THREE.BoxGeometry(0.05, 0.78, 3.85, 1, 3, 12));
  for (const sign of [-1, 1] as const) {
    const sideGlass = new THREE.Mesh(salonWindowGeo, tintedGlassMat);
    sideGlass.position.set(1.18 * sign, 1.56, -0.22);
    sideGlass.rotation.y = -0.05 * sign;
    cabinGroup.add(sideGlass);
  }

  const mainWindshield = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.24, 0.95, 0.06, 8, 4, 1)),
    tintedGlassMat
  );
  mainWindshield.position.set(0, 1.66, 2.02);
  mainWindshield.rotation.x = -0.78;
  cabinGroup.add(mainWindshield);

  const aftGlassDoors = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.12, 0.96, 0.05, 8, 4, 1)),
    tintedGlassMat
  );
  aftGlassDoors.position.set(0, 1.48, -2.32);
  cabinGroup.add(aftGlassDoors);

  // Main Cabin Ceiling / Flybridge Structural Floor Deck
  const flyFloorShape = new THREE.Shape();
  flyFloorShape.moveTo(-1.26, -3.55);
  flyFloorShape.lineTo(1.26, -3.55);
  flyFloorShape.lineTo(1.18, 1.35);
  flyFloorShape.quadraticCurveTo(0, 1.95, -1.18, 1.35);
  flyFloorShape.lineTo(-1.26, -3.55);

  const flyFloorGeo = trackGeo(
    new THREE.ExtrudeGeometry(flyFloorShape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.04,
      bevelSegments: 2,
      curveSegments: 14,
    })
  );
  flyFloorGeo.rotateX(Math.PI / 2);
  const flyFloor = new THREE.Mesh(flyFloorGeo, superWhiteMat);
  flyFloor.position.set(0, 2.27, 0);
  cabinGroup.add(flyFloor);

  // 5. Interior Salon Lounge & Illuminated Helm Console
  const interiorDeckFloor = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.25, 0.06, 4.3, 6, 1, 12)),
    teakMat
  );
  interiorDeckFloor.position.set(0, 1.02, -0.2);
  cabinGroup.add(interiorDeckFloor);

  const sofaBase = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.68, 0.34, 2.15, 3, 2, 8)),
    creamUpholsteryMat
  );
  sofaBase.position.set(-0.76, 1.22, -0.72);
  cabinGroup.add(sofaBase);

  const salonTable = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.64, 0.08, 1.05, 3, 1, 4)),
    teakMat
  );
  salonTable.position.set(0.08, 1.36, -0.62);
  cabinGroup.add(salonTable);

  const helmConsole = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.95, 0.38, 0.42, 4, 2, 2)),
    lowerKeelMat
  );
  helmConsole.position.set(0.56, 1.18, 1.32);
  cabinGroup.add(helmConsole);

  const helmScreen = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.54, 0.19, 0.03, 3, 2, 1)),
    helmDisplayMat
  );
  helmScreen.position.set(0.56, 1.42, 1.42);
  helmScreen.rotation.x = -0.45;
  cabinGroup.add(helmScreen);

  // 6. Upper Flybridge Windscreen, Sun Visor Roof, Dual SATCOM Domes & Mast Array
  const flyCoaming = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.15, 0.36, 3.35, 8, 2, 10)),
    superWhiteMat
  );
  flyCoaming.position.set(0, 2.38, -1.45);
  cabinGroup.add(flyCoaming);

  const flyWindscreen = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.94, 0.58, 0.05, 8, 3, 1)),
    tintedGlassMat
  );
  flyWindscreen.position.set(0, 2.66, 0.65);
  flyWindscreen.rotation.x = -0.82;
  cabinGroup.add(flyWindscreen);

  // Streamlined Flybridge Sun Roof & Radar Arch -> Mast & Hierarchy Sub-Assembly
  const radarArchRoof = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.98, 0.14, 2.45, 8, 1, 8)),
    superWhiteMat
  );
  radarArchRoof.position.set(0, 2.94, -1.05);
  mastGroup.add(radarArchRoof);

  const radarArchCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.96, 2.32, -2.05),
    new THREE.Vector3(-0.92, 2.94, -1.75),
    new THREE.Vector3(0, 3.04, -1.68),
    new THREE.Vector3(0.92, 2.94, -1.75),
    new THREE.Vector3(0.96, 2.32, -2.05),
  ]);
  const radarArchMesh = new THREE.Mesh(
    trackGeo(new THREE.TubeGeometry(radarArchCurve, 28, 0.085, 10, false)),
    superWhiteMat
  );
  mastGroup.add(radarArchMesh);

  const domeGeo = trackGeo(new THREE.SphereGeometry(0.24, 20, 16));
  const domeBaseGeo = trackGeo(new THREE.CylinderGeometry(0.16, 0.2, 0.14, 16, 2));
  for (const sign of [-1, 1] as const) {
    const domeBase = new THREE.Mesh(domeBaseGeo, superWhiteMat);
    domeBase.position.set(0.58 * sign, 3.05, -1.55);
    const domeCap = new THREE.Mesh(domeGeo, gelcoatWhiteMat);
    domeCap.scale.set(1, 1.08, 1);
    domeCap.position.set(0.58 * sign, 3.22, -1.55);
    mastGroup.add(domeBase, domeCap);
  }

  const mastColumn = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.055, 0.1, 1.18, 12, 6)),
    superWhiteMat
  );
  mastColumn.position.set(0, 3.55, -1.32);
  mastGroup.add(mastColumn);

  const radarBar = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.92, 0.08, 0.14, 4, 1, 1)),
    gelcoatWhiteMat
  );
  radarBar.position.set(0, 3.45, -1.25);
  radarBarMesh = radarBar;
  mastGroup.add(radarBar);

  const spreaderBar = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.025, 0.025, 0.85, 8, 4)),
    superWhiteMat
  );
  spreaderBar.rotation.z = Math.PI / 2;
  spreaderBar.position.set(0, 3.86, -1.32);
  mastGroup.add(spreaderBar);

  const topBeacon = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.04, 0.06, 0.16, 10, 2)),
    gelcoatWhiteMat
  );
  topBeacon.position.set(0, 4.18, -1.32);
  mastGroup.add(topBeacon);

  const whipGeo = trackGeo(new THREE.CylinderGeometry(0.012, 0.016, 1.25, 6, 6));
  for (const sign of [-1, 1] as const) {
    const whip = new THREE.Mesh(whipGeo, superWhiteMat);
    whip.position.set(0.84 * sign, 3.55, -1.72);
    whip.rotation.x = -0.08;
    mastGroup.add(whip);
  }

  // 7. Stainless Steel Bow Pulpit & Flybridge Aft Guardrails (Deck Group)
  const bowRailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.52, 1.38, -2.5),
    new THREE.Vector3(1.48, 1.48, 1.4),
    new THREE.Vector3(1.12, 1.66, 3.55),
    new THREE.Vector3(0.42, 1.82, 5.25),
    new THREE.Vector3(0.0, 1.88, 5.92),
    new THREE.Vector3(-0.42, 1.82, 5.25),
    new THREE.Vector3(-1.12, 1.66, 3.55),
    new THREE.Vector3(-1.48, 1.48, 1.4),
    new THREE.Vector3(-1.52, 1.38, -2.5),
  ]);
  deckGroup.add(
    new THREE.Mesh(trackGeo(new THREE.TubeGeometry(bowRailCurve, 56, 0.024, 8, false)), stainlessMat)
  );

  const stanchionGeo = trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 6, 3));
  const railZAnchors = [-2.2, -0.5, 1.2, 2.7, 4.0, 5.1];
  const railXAnchors = [1.52, 1.54, 1.48, 1.26, 0.92, 0.46];
  const railYAnchors = [1.22, 1.24, 1.29, 1.42, 1.54, 1.64];
  railZAnchors.forEach((rz, idx) => {
    for (const sign of [-1, 1] as const) {
      const post = new THREE.Mesh(stanchionGeo, stainlessMat);
      post.position.set(railXAnchors[idx] * sign, railYAnchors[idx], rz);
      deckGroup.add(post);
    }
  });

  const flyRailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.12, 2.58, -0.8),
    new THREE.Vector3(1.14, 2.66, -3.35),
    new THREE.Vector3(0.0, 2.68, -3.45),
    new THREE.Vector3(-1.14, 2.66, -3.35),
    new THREE.Vector3(-1.12, 2.58, -0.8),
  ]);
  deckGroup.add(
    new THREE.Mesh(trackGeo(new THREE.TubeGeometry(flyRailCurve, 32, 0.02, 8, false)), stainlessMat)
  );

  // 8. Underwater Twin Bronze 4-Blade Propellers, Shafts, P-Struts & Rudders (Propulsion Group)
  const shaftGeo = trackGeo(new THREE.CylinderGeometry(0.04, 0.04, 1.45, 10, 4));
  shaftGeo.rotateX(Math.PI / 2 - 0.14);
  const strutGeo = trackGeo(new THREE.BoxGeometry(0.05, 0.42, 0.16, 1, 3, 1));
  const rudderGeo = trackGeo(new THREE.BoxGeometry(0.06, 0.44, 0.34, 1, 3, 2));
  const hubGeo = trackGeo(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 12, 2));
  hubGeo.rotateX(Math.PI / 2);
  const bladeGeo = trackGeo(new THREE.BoxGeometry(0.24, 0.03, 0.12, 2, 1, 1));

  for (const sign of [-1, 1] as const) {
    const px = 0.56 * sign;

    const shaft = new THREE.Mesh(shaftGeo, stainlessMat);
    shaft.position.set(px, -0.44, -3.45);
    propulsionGroup.add(shaft);

    const strut = new THREE.Mesh(strutGeo, bronzePropMat);
    strut.position.set(px, -0.34, -3.85);
    propulsionGroup.add(strut);

    const rudder = new THREE.Mesh(rudderGeo, bronzePropMat);
    rudder.position.set(px, -0.52, -4.62);
    propulsionGroup.add(rudder);

    const propPivot = new THREE.Group();
    propPivot.position.set(px, -0.54, -4.16);
    propPivot.add(new THREE.Mesh(hubGeo, bronzePropMat));

    for (let b = 0; b < 4; b++) {
      const bladeHolder = new THREE.Group();
      bladeHolder.rotation.z = (b * Math.PI) / 2;
      const blade = new THREE.Mesh(bladeGeo, bronzePropMat);
      blade.position.set(0.14, 0, 0);
      blade.rotation.x = 0.46;
      bladeHolder.add(blade);
      propPivot.add(bladeHolder);
    }
    propulsionGroup.add(propPivot);
    propellers.push(propPivot);
  }

  // 9. Animated 3D Ocean Wave Plane + Wave Contour Wireframe + Twin Stern V-Wake
  const seaGeo = trackGeo(new THREE.PlaneGeometry(220, 220, 72, 72));
  seaGeo.rotateX(-Math.PI / 2);
  const seaPosAttr = seaGeo.attributes.position as THREE.BufferAttribute;
  const seaVertexCount = seaPosAttr.count;
  const seaBaseXZ = new Float32Array(seaVertexCount * 2);
  for (let i = 0; i < seaVertexCount; i++) {
    seaBaseXZ[i * 2] = seaPosAttr.getX(i);
    seaBaseXZ[i * 2 + 1] = seaPosAttr.getZ(i);
  }

  const seaSurfaceMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0b3a75,
      roughness: 0.28,
      metalness: 0.14,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  const seaMesh = new THREE.Mesh(seaGeo, seaSurfaceMat);
  seaMesh.position.y = 0.0;

  const seaWireMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    })
  );
  const seaWireMesh = new THREE.Mesh(seaGeo, seaWireMat);
  seaWireMesh.position.y = 0.012;

  // Dynamic V-wake chevrons trailing behind the moving stern
  const wakeMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  const wakeVGroup = new THREE.Group();
  const wakeWingGeo = trackGeo(new THREE.PlaneGeometry(0.18, 12.5));
  wakeWingGeo.rotateX(-Math.PI / 2);
  for (const sign of [-1, 1] as const) {
    const wing = new THREE.Mesh(wakeWingGeo, wakeMat);
    wing.position.set(2.3 * sign, 0.05, -10.8);
    wing.rotation.y = 0.27 * sign;
    wakeVGroup.add(wing);
  }
  yacht.add(wakeVGroup);

  // Subtle horizontal waterline telemetry ring around the yacht
  const wakeRingGeo = trackGeo(new THREE.RingGeometry(6.8, 6.86, 72));
  wakeRingGeo.rotateX(-Math.PI / 2);
  const wakeRingMat = registerMat(
    new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    0.16
  );
  const wakeRing = new THREE.Mesh(wakeRingGeo, wakeRingMat);
  wakeRing.position.y = 0.04;
  yacht.add(wakeRing);

  // 10. Inner Geodesic Sphere & Connecting Lines INSIDE the Boat (Stage 3 reveal)
  const innerSphereGroup = new THREE.Group();
  innerSphereGroup.position.set(0, 1.32, 0.22);

  const sphereLineMat = trackMat(
    new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  const sphereCoreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe0f2fe,
      emissive: new THREE.Color(0x38bdf8),
      emissiveIntensity: 1.35,
      roughness: 0.15,
      transparent: true,
      opacity: 0,
    })
  );

  // Outer geodesic wireframe sphere glowing inside the cutaway cabin & hull
  const outerIcoGeo = trackGeo(new THREE.IcosahedronGeometry(0.92, 1));
  const outerEdgesGeo = trackGeo(new THREE.EdgesGeometry(outerIcoGeo));
  const outerWireSphere = new THREE.LineSegments(outerEdgesGeo, sphereLineMat);
  innerSphereGroup.add(outerWireSphere);

  // Equatorial & inclined architectural orbit rings inside the vessel
  const orbitRingGeo = trackGeo(new THREE.TorusGeometry(1.18, 0.014, 8, 48));
  const orbitRingMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  const orbitRingA = new THREE.Mesh(orbitRingGeo, orbitRingMat);
  orbitRingA.rotation.x = Math.PI / 2 - 0.28;
  const orbitRingB = new THREE.Mesh(orbitRingGeo, orbitRingMat);
  orbitRingB.rotation.x = Math.PI / 3;
  orbitRingB.rotation.y = 0.72;
  innerSphereGroup.add(orbitRingA, orbitRingB);

  // Glowing inner core orb
  const coreBall = new THREE.Mesh(
    trackGeo(new THREE.SphereGeometry(0.32, 22, 16)),
    sphereCoreMat
  );
  innerSphereGroup.add(coreBall);

  // Radial structural connecting lines from the inner sphere core out to key internal vessel anchors
  const radialNodesLocal: [number, number, number][] = [
    [0.0, 2.05, -1.25], // Upper bridge & helm flow
    [1.15, 0.45, 0.15], // Starboard hull shell
    [0.95, -0.58, 2.35], // Forward deck & UI system
    [0.54, -1.65, -3.95], // Stern propulsion & motion
  ];
  const connectPositions = new Float32Array(radialNodesLocal.length * 6);
  const nodeBallGeo = trackGeo(new THREE.SphereGeometry(0.065, 12, 8));
  radialNodesLocal.forEach((pt, idx) => {
    connectPositions[idx * 6 + 0] = 0;
    connectPositions[idx * 6 + 1] = 0;
    connectPositions[idx * 6 + 2] = 0;
    connectPositions[idx * 6 + 3] = pt[0];
    connectPositions[idx * 6 + 4] = pt[1];
    connectPositions[idx * 6 + 5] = pt[2];
    const nodeDot = new THREE.Mesh(nodeBallGeo, sphereCoreMat);
    nodeDot.position.set(pt[0], pt[1], pt[2]);
    innerSphereGroup.add(nodeDot);
  });
  const connectGeo = trackGeo(new THREE.BufferGeometry());
  connectGeo.setAttribute('position', new THREE.BufferAttribute(connectPositions, 3));
  const innerConnectLines = new THREE.LineSegments(connectGeo, sphereLineMat);
  innerSphereGroup.add(innerConnectLines);

  yacht.add(innerSphereGroup);

  // Blueprint Assembly Guide Hairlines
  const guidePositions = new Float32Array([
    -1.2, -1.4, -2.2, -1.2, 4.1, -2.2,
    1.2, -1.4, -2.2, 1.2, 4.1, -2.2,
    -1.1, -1.1, 2.2, -1.1, 3.1, 2.2,
    1.1, -1.1, 2.2, 1.1, 3.1, 2.2,
    0.0, -1.5, 0.0, 0.0, 4.6, 0.0,
  ]);
  const guideGeo = trackGeo(new THREE.BufferGeometry());
  guideGeo.setAttribute('position', new THREE.BufferAttribute(guidePositions, 3));
  const guideMat = trackMat(
    new THREE.LineBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  const explodeGuides = new THREE.LineSegments(guideGeo, guideMat);
  yacht.add(explodeGuides);

  return {
    yacht,
    hullGroup,
    deckGroup,
    cabinGroup,
    mastGroup,
    propulsionGroup,
    radarBarMesh,
    gelcoatWhiteMat,
    superWhiteMat,
    teakMat,
    stainlessMat,
    fadeableMaterials,
    propellers,
    seaMesh,
    seaWireMesh,
    seaPosAttr,
    seaBaseXZ,
    seaGeo,
    seaSurfaceMat,
    seaWireMat,
    wakeMat,
    wakeVGroup,
    wakeRingMat,
    wakeRing,
    innerSphereGroup,
    outerWireSphere,
    orbitRingMat,
    sphereLineMat,
    sphereCoreMat,
    guideMat,
  };
}

export function createCircleFormation3D(
  mount: HTMLElement,
  initialWidth: number,
  initialHeight: number
): CircleFormation3DHandle | null {
  const isSoftwareGl = detectSoftwareWebGL();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isSoftwareGl,
      preserveDrawingBuffer: isSoftwareGl,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(initialWidth, initialHeight, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.setAttribute('data-testid', 'circle-formation-canvas');
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRenderTarget.texture;
  pmremGenerator.dispose();

  // Studio 3-point warm/cool lighting rig
  const hemiLight = new THREE.HemisphereLight(0xf0f9ff, 0x0f172a, 1.35);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff6ea, 2.2);
  keyLight.position.set(10, 12, 9);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x7dd3fc, 1.5);
  rimLight.position.set(-10, -4, -9);
  scene.add(rimLight);

  const underKeelFill = new THREE.DirectionalLight(0x38bdf8, 1.2);
  underKeelFill.position.set(4, -10, 3);
  scene.add(underKeelFill);

  const camera = new THREE.PerspectiveCamera(
    42,
    initialWidth / Math.max(initialHeight, 1),
    0.1,
    260
  );

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const teakTexture = createTeakTexture(maxAnisotropy);
  const {
    yacht,
    hullGroup,
    deckGroup,
    cabinGroup,
    mastGroup,
    propulsionGroup,
    radarBarMesh,
    gelcoatWhiteMat,
    superWhiteMat,
    teakMat,
    stainlessMat,
    fadeableMaterials,
    propellers,
    seaMesh,
    seaWireMesh,
    seaPosAttr,
    seaBaseXZ,
    seaGeo,
    seaSurfaceMat,
    seaWireMat,
    wakeMat,
    wakeVGroup,
    wakeRingMat,
    innerSphereGroup,
    outerWireSphere,
    orbitRingMat,
    sphereLineMat,
    sphereCoreMat,
    guideMat,
  } = buildLuxuryYachtGroup(teakTexture, trackGeo, trackMat);
  scene.add(seaMesh, seaWireMesh, yacht);

  // Subtle deep underwater depth rings visible below y = 0 in Stage 4 dive
  const depthRingsMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
  );
  const underwaterRingsGroup = new THREE.Group();
  [-1.8, -3.6, -5.4].forEach((depthY, idx) => {
    const rGeo = trackGeo(new THREE.RingGeometry(4.2 + idx * 2.2, 4.28 + idx * 2.2, 64));
    rGeo.rotateX(-Math.PI / 2);
    const rMesh = new THREE.Mesh(rGeo, depthRingsMat);
    rMesh.position.y = depthY;
    underwaterRingsGroup.add(rMesh);
  });
  scene.add(underwaterRingsGroup);

  // Anchor coordinates aligned to the 4 radial endpoints inside the boat
  const anchorSubGroups: Record<
    YachtCalloutKey,
    { group: THREE.Group; local: THREE.Vector3 }
  > = {
    hierarchy: { group: innerSphereGroup, local: new THREE.Vector3(0.0, 2.05, -1.25) },
    shell: { group: innerSphereGroup, local: new THREE.Vector3(1.15, 0.45, 0.15) },
    system: { group: innerSphereGroup, local: new THREE.Vector3(0.95, -0.58, 2.35) },
    motion: { group: innerSphereGroup, local: new THREE.Vector3(0.54, -1.65, -3.95) },
  };

  let gpuBusy = false;
  let lastTheme: 'light' | 'dark' | null = null;
  let clearedSinceInvisible = true;
  let pendingTimer = 0;
  let disposed = false;

  const waitForAfterDraw = () => {
    if (!isSoftwareGl) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== 'function') {
      gpuBusy = false;
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const startWait = performance.now();
    const poll = () => {
      if (disposed) {
        if (sync && gl.isSync(sync)) gl.deleteSync(sync);
        return;
      }
      const timedOut = performance.now() - startWait > 140;
      const status =
        !timedOut && sync && gl.isSync(sync)
          ? gl.getSyncParameter(sync, gl.SYNC_STATUS)
          : gl.SIGNALED;
      if (status === gl.UNSIGNALED && !timedOut) {
        pendingTimer = window.setTimeout(poll, 4);
      } else {
        if (sync && gl.isSync(sync)) gl.deleteSync(sync);
        gpuBusy = false;
      }
    };
    gpuBusy = true;
    pendingTimer = window.setTimeout(poll, 4);
  };

  const syncPalette = (theme: 'light' | 'dark') => {
    if (lastTheme === theme) return;
    lastTheme = theme;
    const isDark = theme === 'dark';
    seaSurfaceMat.color.setHex(isDark ? 0x0b3a75 : 0x0369a1);
    seaWireMat.color.setHex(isDark ? 0x38bdf8 : 0x1d4ed8);
    wakeMat.color.setHex(isDark ? 0xbae6fd : 0x1e40af);
    wakeRingMat.color.setHex(isDark ? 0x93c5fd : 0x1d4ed8);
    guideMat.color.setHex(isDark ? 0x93c5fd : 0x0f359e);
    sphereLineMat.color.setHex(isDark ? 0x7dd3fc : 0x0f359e);
    orbitRingMat.color.setHex(isDark ? 0x93c5fd : 0x1d4ed8);
    depthRingsMat.color.setHex(isDark ? 0x38bdf8 : 0x0369a1);
    sphereCoreMat.color.setHex(isDark ? 0xe0f2fe : 0x1d4ed8);
    sphereCoreMat.emissive.setHex(isDark ? 0x38bdf8 : 0x2563eb);
    hemiLight.intensity = isDark ? 1.3 : 1.45;
  };

  syncPalette('dark');

  const clearCanvas = () => {
    if (clearedSinceInvisible) return;
    renderer.clear();
    clearedSinceInvisible = true;
  };

  const resize = (width: number, height: number) => {
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  };

  const updateAndRender = (
    state: VoyageFrameState,
    effectiveAlpha: number,
    elapsedTimeSec: number,
    theme: 'light' | 'dark',
    viewportWidth: number,
    _viewportHeight: number
  ): YachtAnchorProjectionMap | null => {
    if (disposed) return null;
    if (effectiveAlpha <= 0.004) {
      clearCanvas();
      return null;
    }

    if (isSoftwareGl && gpuBusy) {
      return null;
    }

    syncPalette(theme);
    clearedSinceInvisible = false;

    const isMobile = viewportWidth < 768;
    const aspect = viewportWidth / Math.max(_viewportHeight, 1);
    const mobileDistScale = aspect < 0.8 ? clamp(0.8 / aspect, 1.35, 2.0) : 1.0;

    // 1. Animated 3D Ocean Waves rolling past the moving yacht
    const sailOffset = state.boatSailProgress * 14.0 + elapsedTimeSec * 1.45;
    const waveVerts = seaPosAttr.count;
    for (let i = 0; i < waveVerts; i++) {
      const wx = seaBaseXZ[i * 2];
      const wz = seaBaseXZ[i * 2 + 1];
      const wy =
        Math.sin(wx * 0.22 + elapsedTimeSec * 1.35) * 0.28 +
        Math.cos(wz * 0.17 - sailOffset * 0.35) * 0.24 +
        Math.sin((wx + wz) * 0.32 - sailOffset * 0.28) * 0.11;
      seaPosAttr.setY(i, wy);
    }
    seaPosAttr.needsUpdate = true;
    seaGeo.computeVertexNormals();

    // 2. Boat visibly sails forward along +Z across the waves during Stages 1 & 2
    const boatZ = (state.boatSailProgress - 0.35) * 9.0;
    const heaveScale = 1 - state.coreRevealProgress * 0.65;
    yacht.position.set(
      0,
      Math.sin(elapsedTimeSec * 1.35) * 0.065 * heaveScale,
      boatZ
    );
    yacht.rotation.set(
      Math.sin(elapsedTimeSec * 1.05) * 0.018 * heaveScale,
      Math.sin(elapsedTimeSec * 0.45) * 0.025 * heaveScale,
      Math.cos(elapsedTimeSec * 1.2) * 0.022 * heaveScale
    );

    // Keep ocean grid centered under the sailing boat horizontally so waves never clip edges
    seaMesh.position.set(0, 0, boatZ);
    seaWireMesh.position.set(0, 0.015, boatZ);
    underwaterRingsGroup.position.set(0, 0, boatZ);

    // Spin twin propellers and radar bar continuously
    const propSpinSpeed = 4.5 + (1 - state.coreRevealProgress) * 3.5;
    propellers.forEach((prop, idx) => {
      prop.rotation.z = elapsedTimeSec * (idx === 0 ? propSpinSpeed : -propSpinSpeed);
    });
    if (radarBarMesh) {
      radarBarMesh.rotation.y = elapsedTimeSec * 1.65;
    }

    // 3. Stage 3 Subtle Architectural Cutaway Separation + Inner Glowing Sphere Inside Boat
    const coreRev = state.coreRevealProgress;
    const exp = state.explodeProgress;
    mastGroup.position.set(0, exp * 1.55, 0);
    cabinGroup.position.set(0, exp * 0.78, 0);
    deckGroup.position.set(0, exp * 0.22, 0);
    hullGroup.position.set(0, -exp * 0.32, 0);
    propulsionGroup.position.set(0, -exp * 0.85, 0);

    outerWireSphere.rotation.y = elapsedTimeSec * 0.55;
    outerWireSphere.rotation.x = Math.sin(elapsedTimeSec * 0.4) * 0.18;
    innerSphereGroup.visible = coreRev > 0.01;
    sphereLineMat.opacity = clamp(coreRev * 0.92 * effectiveAlpha, 0, 0.92);
    orbitRingMat.opacity = clamp(coreRev * 0.55 * effectiveAlpha, 0, 0.55);
    sphereCoreMat.opacity = clamp(coreRev * 0.96 * effectiveAlpha, 0, 0.96);

    // 4. Material opacity (gentle semi-translucent outer shell during Stage 3 so the inner sphere shines cleanly through)
    const alphaClamped = clamp(effectiveAlpha, 0, 1);
    const isFading = alphaClamped < 0.995;
    const cutawayFactor = coreRev * 0.46;
    for (let i = 0; i < fadeableMaterials.length; i++) {
      const entry = fadeableMaterials[i];
      const isShellMat =
        entry.mat === gelcoatWhiteMat ||
        entry.mat === superWhiteMat ||
        entry.mat === teakMat ||
        entry.mat === stainlessMat;
      const shellMult = isShellMat ? 1 - cutawayFactor : 1;
      const shouldBeTransparent =
        entry.alwaysTransparent || isFading || (isShellMat && cutawayFactor > 0.01);
      if (entry.mat.transparent !== shouldBeTransparent) {
        entry.mat.transparent = shouldBeTransparent;
        entry.mat.needsUpdate = true;
      }
      entry.mat.opacity = entry.baseOpacity * alphaClamped * shellMult;
    }

    seaSurfaceMat.opacity = 0.24 * alphaClamped;
    seaWireMat.opacity = 0.19 * alphaClamped;
    wakeMat.opacity = clamp((1 - coreRev * 0.7) * (1 - state.diveUnderProgress) * 0.26 * alphaClamped, 0, 0.26);
    wakeVGroup.visible = wakeMat.opacity > 0.01;
    guideMat.opacity = clamp(exp * 0.26 * alphaClamped, 0, 0.26);

    // 5. 4-Stage Camera Path:
    // Stage 1: Far Top-Right ~75° Steep Aerial Perspective looking down at moving boat + waves
    // Stage 2: Smooth swoop down closer to the boat alongside speed lines
    // Stage 3: Architectural orbit inspecting the inner sphere + connecting lines inside the boat
    // Stage 4: Exterior radial dive deep under the ocean waves beneath boat keel & twin propellers
    const tProg = state.telescopeProgress;
    const rProg = state.speedRushProgress;
    const cProg = state.coreRevealProgress;
    const iProg = state.inspectProgress;
    const dProg = state.diveUnderProgress;

    // Far top-right ~75° aerial angle (atan2(82, 22.0) ≈ 75.0°)
    const stage1X = (17.5 - tProg * 1.6) * mobileDistScale;
    const stage1Y = 82.0 - tProg * 8.0;
    const stage1Z = boatZ + (13.3 - tProg * 1.2) * mobileDistScale;

    // Close hero 3/4 view (destination of Stage 2 speed approach)
    const closeX = 11.8 * mobileDistScale;
    const closeY = 3.5;
    const closeZ = boatZ + 11.2 * mobileDistScale;

    const rushEase = rProg * rProg * (3 - 2 * rProg);
    let cx = stage1X + (closeX - stage1X) * rushEase;
    let cy = stage1Y + (closeY - stage1Y) * rushEase;
    let cz = stage1Z + (closeZ - stage1Z) * rushEase;

    let lx = 0;
    let ly = 0.4 + rushEase * 0.8;
    let lz = boatZ;

    // Stage 3: Gentle orbital inspection framing the boat interior & inner glowing sphere
    const orbitAngle = (iProg - 0.35) * 0.36;
    const cosO = Math.cos(orbitAngle);
    const sinO = Math.sin(orbitAngle);
    const baseExpX = 12.8;
    const baseExpZ = 12.2;
    const coreCamX = (baseExpX * cosO - baseExpZ * sinO) * mobileDistScale;
    const coreCamY = 3.45 - iProg * 0.25;
    const coreCamZ = boatZ + (baseExpX * sinO + baseExpZ * cosO) * mobileDistScale;

    cx = cx + (coreCamX - cx) * cProg;
    cy = cy + (coreCamY - cy) * cProg;
    cz = cz + (coreCamZ - cz) * cProg;
    ly = ly + (1.28 - ly) * cProg;

    // Stage 4: Dive along an exterior polar arc deep under the waves, keeping safe standoff around the hull
    if (dProg > 0.0001) {
      const preRadius = Math.hypot(cx, cz - boatZ);
      const preAzimuth = Math.atan2(cx, cz - boatZ);
      const diveEase = dProg * dProg * (3 - 2 * dProg);
      const diveSubmerge = clamp(dProg / 0.78, 0, 1);
      const submergeCurve = diveSubmerge * diveSubmerge * (3 - 2 * diveSubmerge);

      const targetDiveRadius = 15.8 * mobileDistScale;
      const targetDiveAzimuth = 2.18;
      const finalRadius = preRadius + (targetDiveRadius - preRadius) * diveEase;
      const finalAzimuth = preAzimuth + (targetDiveAzimuth - preAzimuth) * diveEase;

      cx = Math.sin(finalAzimuth) * finalRadius;
      cz = boatZ + Math.cos(finalAzimuth) * finalRadius;
      cy = cy + (-6.8 - cy) * submergeCurve;
      ly = ly + (-0.35 - ly) * diveEase;
      lz = lz + (boatZ - 0.6 - lz) * diveEase;
    }

    // Illuminate underwater depth rings smoothly when diving beneath the surface (cy < 0)
    const underWaterFactor = clamp(-cy / 3.5, 0, 1);
    depthRingsMat.opacity = underWaterFactor * 0.28 * alphaClamped;
    underwaterRingsGroup.visible = depthRingsMat.opacity > 0.01;

    // Smooth optical FOV
    const baseFov = isMobile ? 48 : 42;
    const targetFov = baseFov + state.speedIntensity * 9 + dProg * 5;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }

    _camPos.set(cx, cy, cz);
    _camLook.set(lx, ly, lz);
    camera.position.copy(_camPos);
    camera.lookAt(_camLook);
    camera.updateMatrixWorld();
    yacht.updateMatrixWorld(true);

    renderer.render(scene, camera);
    waitForAfterDraw();

    // Project the 4 radial endpoints of the inner Sphere connecting lines onto screen space
    const projection = {} as YachtAnchorProjectionMap;
    (Object.keys(anchorSubGroups) as YachtCalloutKey[]).forEach((key) => {
      const entry = anchorSubGroups[key];
      _projVec.copy(entry.local).applyMatrix4(entry.group.matrixWorld);
      _projVec.project(camera);
      const xPct = clamp((_projVec.x * 0.5 + 0.5) * 100, 12, 88);
      const yPct = clamp((-_projVec.y * 0.5 + 0.5) * 100, 14, 86);
      projection[key] = {
        xPct,
        yPct,
        visible: _projVec.z >= -1 && _projVec.z <= 1,
      };
    });

    return projection;
  };

  if (!isSoftwareGl) {
    renderer.compile(scene, camera);
  }

  return {
    updateAndRender,
    clearCanvas,
    resize,
    dispose: () => {
      disposed = true;
      window.clearTimeout(pendingTimer);
      scene.environment = null;
      envRenderTarget.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      teakTexture.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    },
    domElement: renderer.domElement,
  };
}
