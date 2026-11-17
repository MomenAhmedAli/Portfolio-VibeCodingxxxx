import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVoyageFrameState,
  computeVoyageSectionProgress,
  isCompassActiveInSection,
} from './voyageChoreography';

test('isCompassActiveInSection is false outside section and true when dominant in viewport', () => {
  const vh = 900;
  assert.equal(isCompassActiveInSection(1200, 5200, vh), false);
  assert.equal(isCompassActiveInSection(700, 5200, vh), false);
  assert.equal(isCompassActiveInSection(-4800, -100, vh), false);
  assert.equal(isCompassActiveInSection(300, 4800, vh), true);
});

test('computeVoyageSectionProgress clamps smoothly between 0 and 1', () => {
  assert.equal(computeVoyageSectionProgress(400, 4680, 900), 0);
  assert.equal(computeVoyageSectionProgress(-5000, 4680, 900), 1);
  const mid = computeVoyageSectionProgress(-1890, 4680, 900);
  assert.ok(Math.abs(mid - 0.5) < 0.01);
});

test('4-stage sea journey flows from far 75deg top-right view, approach speed lines, inner boat sphere, to deep under-hull dive', () => {
  // Stage 1: Far top-right 75deg perspective + boat moving across waves
  const s1a = computeVoyageFrameState(0.08);
  const s1b = computeVoyageFrameState(0.18);
  assert.equal(s1a.stageIndex, 1);
  assert.equal(s1a.yachtAlpha, 1);
  assert.equal(s1a.telescopeAlpha, 1);
  assert.ok(s1b.boatSailProgress > s1a.boatSailProgress);
  assert.equal(s1a.coreRevealProgress, 0);
  assert.equal(s1a.diveUnderProgress, 0);

  // Stage 2: Scroll-driven speed lines swooping closer to boat
  const s2 = computeVoyageFrameState(0.345);
  assert.equal(s2.stageIndex, 2);
  assert.equal(s2.yachtAlpha, 1);
  assert.equal(s2.telescopeReticleAlpha, 1);
  assert.ok(s2.speedRushProgress > 0.4 && s2.speedRushProgress < 0.6);
  assert.ok(s2.speedIntensity > 0.9);
  assert.equal(s2.coreRevealProgress, 0);

  // Stage 3: Inner sphere + connecting lines revealed inside boat
  const s3 = computeVoyageFrameState(0.64);
  assert.equal(s3.stageIndex, 3);
  assert.equal(s3.yachtAlpha, 1);
  assert.equal(s3.speedIntensity, 0);
  assert.equal(s3.coreRevealProgress, 1);
  assert.equal(s3.lineDrawProgress, 1);
  assert.equal(s3.calloutAlpha, 1);
  assert.equal(s3.diveUnderProgress, 0);

  // Stage 4: Camera dives deeper under the boat before exiting cleanly
  const s4 = computeVoyageFrameState(0.85);
  assert.equal(s4.stageIndex, 4);
  assert.ok(s4.diveUnderProgress > 0.5);
  assert.equal(s4.diveLabelAlpha, 1);

  const exit = computeVoyageFrameState(0.985);
  assert.equal(exit.vanishProgress, 1);
  assert.equal(exit.yachtAlpha, 0);
});
