export interface VoyageFrameState {
  stageIndex: 1 | 2 | 3 | 4;
  stageLabel: string;
  /** Overall visibility of the 3D yacht & ocean scene [0..1] */
  yachtAlpha: number;
  /** Distant 75° top-right aerial telescope framing progress [0..1] */
  telescopeProgress: number;
  /** Visibility [0..1] of Stage 1 header */
  telescopeAlpha: number;
  /** Visibility [0..1] of centered target reticle across Stage 1 -> Stage 2 */
  telescopeReticleAlpha: number;
  /** Scroll-driven speed approach progress from far 75° perch down to boat [0..1] */
  speedRushProgress: number;
  /** Intensity [0..1] of scroll-moving speed lines zooming into boat */
  speedIntensity: number;
  /** Forward sailing distance factor [0..1] so the boat visibly cruises through waves */
  boatSailProgress: number;
  /** Stage 3 reveal of the inner glowing sphere + connecting lines inside the boat [0..1] */
  coreRevealProgress: number;
  /** Subtle architectural hull/cabin cutaway separation to reveal the inner sphere [0..1] */
  explodeProgress: number;
  /** Continuous orbital motion while inspecting the inner sphere [0..1] */
  inspectProgress: number;
  /** Draw progress [0..1] of SVG leader pointer lines */
  lineDrawProgress: number;
  /** Visibility [0..1] of "How Design Helps" callout headers */
  calloutAlpha: number;
  /** Stage 4 deep underwater dive beneath the boat keel & propellers [0..1] */
  diveUnderProgress: number;
  /** Visibility [0..1] of Stage 4 underwater header */
  diveLabelAlpha: number;
  /** Final clean exit fade [0..1] before CTA */
  vanishProgress: number;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-5), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Quintic S-curve (zero 1st & 2nd derivative at endpoints) for silky transitions */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-5), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function linearStep(edge0: number, edge1: number, x: number): number {
  return clamp((x - edge0) / Math.max(edge1 - edge0, 1e-5), 0, 1);
}

export function isCompassActiveInSection(
  rectTop: number,
  rectBottom: number,
  viewportHeight: number
): boolean {
  if (viewportHeight <= 0) return false;
  const visibleTop = Math.max(rectTop, 0);
  const visibleBottom = Math.min(rectBottom, viewportHeight);
  const visiblePx = Math.max(0, visibleBottom - visibleTop);
  return visiblePx >= viewportHeight * 0.55;
}

export function computeVoyageSectionProgress(
  rectTop: number,
  rectHeight: number,
  viewportHeight: number
): number {
  const travel = Math.max(rectHeight - viewportHeight, 1);
  return clamp(-rectTop / travel, 0, 1);
}

/**
 * 4-Stage Scroll Choreography:
 * 1. Far Top-Right 75° Perspective over Moving Boat & Animated Waves (0.00 -> 0.24)
 * 2. Scroll-Driven Speed Lines Swooping Closer Into the Boat (0.24 -> 0.45)
 * 3. Sphere + Connecting Lines Inside the Boat Explaining Design Impact (0.45 -> 0.74)
 * 4. Diving Deeper Under the Boat & Keel Before Clean Exit (0.74 -> 0.97)
 */
export function computeVoyageFrameState(rawProgress: number): VoyageFrameState {
  const p = clamp(rawProgress, 0, 1);

  const entryAlpha = linearStep(0.0, 0.05, p);

  // Stage 1: Far top-right 75deg look down at the moving boat sailing through waves
  const telescopeProgress = smootherstep(0.0, 0.24, p);
  const telescopeIn = smoothstep(0.015, 0.08, p);
  const telescopeCopyOut = 1 - smoothstep(0.19, 0.25, p);
  const telescopeAlpha = clamp(telescopeIn * telescopeCopyOut, 0, 1);

  const reticleOut = 1 - smoothstep(0.39, 0.45, p);
  const telescopeReticleAlpha = clamp(telescopeIn * reticleOut, 0, 1);

  // Boat actively sails forward through Stages 1 -> 2, then holds smoothly for interior & under-hull inspection
  const boatSailProgress = clamp(linearStep(0.0, 0.55, p), 0, 1);

  // Stage 2: Rapid dive closer to the boat with scroll-driven inward speed lines
  const speedRushProgress = smootherstep(0.24, 0.45, p);
  const rushBell = Math.sin(speedRushProgress * Math.PI);
  const rawSpeedIntensity = clamp(Math.pow(Math.max(0, rushBell), 0.85), 0, 1);
  const speedIntensity = rawSpeedIntensity < 1e-4 ? 0 : rawSpeedIntensity;

  // Stage 3: Sphere with lines inside boat explaining how design helps (smoothly reveals & closes before dive)
  const coreIn = smootherstep(0.45, 0.56, p);
  const coreOut = 1 - smootherstep(0.71, 0.79, p);
  const coreRevealProgress = clamp(coreIn * coreOut, 0, 1);
  const explodeProgress = coreRevealProgress;

  const inspectProgress = smootherstep(0.50, 0.74, p);
  const lineDrawProgress = smootherstep(0.51, 0.60, p);
  const calloutIn = smootherstep(0.53, 0.61, p);
  const calloutOut = 1 - smoothstep(0.69, 0.75, p);
  const calloutAlpha = clamp(calloutIn * calloutOut, 0, 1);

  // Stage 4: Camera dives deep beneath the ocean surface & under the boat keel/propellers
  const diveUnderProgress = smootherstep(0.74, 0.92, p);
  const diveLabelIn = smoothstep(0.77, 0.83, p);
  const diveLabelOut = 1 - smoothstep(0.90, 0.96, p);
  const diveLabelAlpha = clamp(diveLabelIn * diveLabelOut, 0, 1);

  const vanishProgress = smootherstep(0.90, 0.98, p);
  const yachtAlpha = clamp(entryAlpha * (1 - vanishProgress), 0, 1);

  let stageIndex: 1 | 2 | 3 | 4 = 1;
  let stageLabel = '01 // HORIZON';
  if (p >= 0.74) {
    stageIndex = 4;
    stageLabel = '04 // DEEP HULL';
  } else if (p >= 0.45) {
    stageIndex = 3;
    stageLabel = '03 // DESIGN CORE';
  } else if (p >= 0.24) {
    stageIndex = 2;
    stageLabel = '02 // APPROACH';
  }

  return {
    stageIndex,
    stageLabel,
    yachtAlpha,
    telescopeProgress,
    telescopeAlpha,
    telescopeReticleAlpha,
    speedRushProgress,
    speedIntensity,
    boatSailProgress,
    coreRevealProgress,
    explodeProgress,
    inspectProgress,
    lineDrawProgress,
    calloutAlpha,
    diveUnderProgress,
    diveLabelAlpha,
    vanishProgress,
  };
}
