import { useEffect, useRef } from 'react';
import { addFrameEffect } from '../lib/lenisScrollBus';
import {
  createCircleFormation3D,
  type YachtCalloutKey,
} from '../lib/circleFormation3D';
import {
  clamp,
  computeVoyageFrameState,
  computeVoyageSectionProgress,
} from '../lib/voyageChoreography';

interface ShipVoyageSectionProps {
  theme?: 'light' | 'dark';
}

interface DesignComponentCallout {
  key: YachtCalloutKey;
  title: string;
  labelXPct: number;
  labelYPct: number;
  align: 'left' | 'right';
}

const DESIGN_HELP_CALLOUTS: DesignComponentCallout[] = [
  {
    key: 'hierarchy',
    title: 'Clear User Flows',
    labelXPct: 5,
    labelYPct: 22,
    align: 'left',
  },
  {
    key: 'shell',
    title: 'Calm Accessible UI',
    labelXPct: 5,
    labelYPct: 22,
    align: 'right',
  },
  {
    key: 'system',
    title: 'Scalable Design Systems',
    labelXPct: 5,
    labelYPct: 75,
    align: 'left',
  },
  {
    key: 'motion',
    title: 'Developer Ready Craft',
    labelXPct: 5,
    labelYPct: 75,
    align: 'right',
  },
];

// Radial speed rays aimed directly into the centered target reticle, moving rapidly closer on scroll
const SPEED_RAYS = Array.from({ length: 28 }, (_, i) => {
  const angle = (i / 28) * Math.PI * 2 + (i % 2) * 0.04;
  const rInner = 195 + (i % 4) * 24;
  const rOuter = 445 + (i % 3) * 44;
  const dashLen = 48 + (i % 4) * 18;
  const dashGap = 24 + (i % 3) * 10;
  return {
    x1: 500 + Math.cos(angle) * rOuter,
    y1: 500 + Math.sin(angle) * rOuter,
    x2: 500 + Math.cos(angle) * rInner,
    y2: 500 + Math.sin(angle) * rInner,
    strokeWidth: i % 3 === 0 ? 1.85 : 1.05,
    dashArray: `${dashLen} ${dashGap}`,
    phase: (i % 5) * 18,
  };
});

// Optical telescope degree ticks around the perimeter
const TELESCOPE_TICKS = Array.from({ length: 24 }, (_, i) => {
  const angle = (i / 24) * Math.PI * 2;
  const isMajor = i % 6 === 0;
  const r1 = isMajor ? 222 : 230;
  const r2 = 240;
  return {
    x1: 300 + Math.cos(angle) * r1,
    y1: 300 + Math.sin(angle) * r1,
    x2: 300 + Math.cos(angle) * r2,
    y2: 300 + Math.sin(angle) * r2,
    isMajor,
  };
});

export function ShipVoyageSection({ theme = 'dark' }: ShipVoyageSectionProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const stageLabelRef = useRef<HTMLSpanElement>(null);
  const telescopeOverlayRef = useRef<HTMLDivElement>(null);
  const telescopeCopyRef = useRef<HTMLDivElement>(null);
  const speedOverlayRef = useRef<HTMLDivElement>(null);
  const speedLinesGroupRef = useRef<SVGGElement>(null);
  const thesisRef = useRef<HTMLDivElement>(null);
  const diveOverlayRef = useRef<HTMLDivElement>(null);
  const svgOverlayRef = useRef<SVGSVGElement>(null);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);

  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const section = sectionRef.current;
    const mount = canvasMountRef.current;
    if (!section || !mount) return;

    let vw = window.innerWidth;
    let vh = window.innerHeight;

    const syncSvgViewport = () => {
      if (svgOverlayRef.current) {
        svgOverlayRef.current.setAttribute('viewBox', `0 0 ${Math.max(vw, 1)} ${Math.max(vh, 1)}`);
      }
    };
    syncSvgViewport();

    const formation3D = createCircleFormation3D(mount, vw, vh);
    if (!formation3D) return;

    const handleResize = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      syncSvgViewport();
      formation3D.resize(vw, vh);
    };

    window.addEventListener('resize', handleResize);

    let disposed = false;
    let hasInitialized = false;
    let smoothProgress = 0;
    let elapsedSec = 0;

    const hideAllOverlays = () => {
      if (telescopeOverlayRef.current) telescopeOverlayRef.current.style.opacity = '0';
      if (telescopeCopyRef.current) telescopeCopyRef.current.style.opacity = '0';
      if (speedOverlayRef.current) speedOverlayRef.current.style.opacity = '0';
      if (thesisRef.current) thesisRef.current.style.opacity = '0';
      if (diveOverlayRef.current) diveOverlayRef.current.style.opacity = '0';
      if (svgOverlayRef.current) svgOverlayRef.current.style.opacity = '0';
      labelRefs.current.forEach((el) => {
        if (el) el.style.opacity = '0';
      });
    };

    const removeEffect = addFrameEffect(20, (_timeMs, delta) => {
      if (disposed) return;

      const dt = Math.min(Math.max(delta, 1 / 240), 0.1);
      const rect = section.getBoundingClientRect();
      if (rect.bottom < -120 || rect.top > vh + 120) {
        hasInitialized = false;
        formation3D.clearCanvas();
        hideAllOverlays();
        return;
      }

      const rawProgress = computeVoyageSectionProgress(rect.top, rect.height, vh);
      if (!hasInitialized || Math.abs(rawProgress - smoothProgress) > 0.18) {
        smoothProgress = rawProgress;
        hasInitialized = true;
      } else {
        const dampRate = rawProgress >= 0.88 ? 18 : rawProgress >= 0.45 ? 9 : 11;
        smoothProgress += (rawProgress - smoothProgress) * (1 - Math.exp(-dt * dampRate));
      }
      const state = computeVoyageFrameState(smoothProgress);

      const exitGuard =
        rawProgress > 0.78 ? clamp((rect.bottom - vh * 0.86) / (vh * 0.14), 0, 1) : 1;
      const effectiveYachtAlpha = state.yachtAlpha * exitGuard;

      elapsedSec += dt;

      if (stageLabelRef.current) {
        stageLabelRef.current.textContent = state.stageLabel;
      }

      const anchors = formation3D.updateAndRender(
        state,
        effectiveYachtAlpha,
        elapsedSec,
        themeRef.current,
        vw,
        vh
      );

      // Stage 1: Optical Reticle framing distant moving boat from 75deg top-right
      const reticleAlpha = state.telescopeReticleAlpha * exitGuard;
      if (telescopeOverlayRef.current) {
        const teleScale = 1 + state.telescopeProgress * 0.04 + state.speedRushProgress * 0.08;
        telescopeOverlayRef.current.style.opacity = reticleAlpha.toFixed(3);
        telescopeOverlayRef.current.style.transform = `scale(${teleScale.toFixed(4)})`;
      }

      const teleCopyAlpha = state.telescopeAlpha * exitGuard;
      if (telescopeCopyRef.current) {
        const copySlideY = (1 - state.telescopeAlpha) * 16;
        telescopeCopyRef.current.style.opacity = teleCopyAlpha.toFixed(3);
        telescopeCopyRef.current.style.transform = `translate3d(0, ${copySlideY.toFixed(1)}px, 0)`;
      }

      // Stage 2: Scroll-driven radial speed lines racing closer into the boat
      const rushAlpha = state.speedIntensity * exitGuard;
      if (speedOverlayRef.current) {
        speedOverlayRef.current.style.opacity = rushAlpha.toFixed(3);
      }
      if (speedLinesGroupRef.current && rushAlpha > 0.01) {
        const scrollZoomScale = 1.15 - state.speedRushProgress * 0.28;
        const scrollTwistDeg = (state.speedRushProgress - 0.5) * 9;
        speedLinesGroupRef.current.style.transform = `scale(${scrollZoomScale.toFixed(4)}) rotate(${scrollTwistDeg.toFixed(2)}deg)`;
        speedLinesGroupRef.current.style.transformOrigin = '500px 500px';
        const lines = speedLinesGroupRef.current.children;
        for (let i = 0; i < lines.length; i++) {
          const lineEl = lines[i] as SVGLineElement;
          const phase = SPEED_RAYS[i]?.phase ?? 0;
          lineEl.style.strokeDashoffset = (-(state.speedRushProgress * 340 + phase)).toFixed(1);
        }
      }

      // Stage 3: Inner Sphere Leader Lines & "How Design Helps" Headers
      const calloutOpacity = state.calloutAlpha * exitGuard;
      const drawPct = clamp(state.lineDrawProgress, 0, 1);

      if (svgOverlayRef.current) {
        svgOverlayRef.current.style.opacity = calloutOpacity.toFixed(3);
      }
      if (thesisRef.current) {
        thesisRef.current.style.opacity = calloutOpacity.toFixed(3);
      }

      // Stage 4: Deep Under-Hull Dive Header
      if (diveOverlayRef.current) {
        diveOverlayRef.current.style.opacity = (state.diveLabelAlpha * exitGuard).toFixed(3);
      }

      const isMobile = vw < 768;

      DESIGN_HELP_CALLOUTS.forEach((item, idx) => {
        const labelEl = labelRefs.current[idx];
        const pathEl = pathRefs.current[idx];
        const dotEl = dotRefs.current[idx];

        const anchor = anchors ? anchors[item.key] : null;
        const marginPct = isMobile ? 4.5 : item.labelXPct;
        const rowYPct = isMobile ? (item.labelYPct < 50 ? 20 : 78) : item.labelYPct;
        const labelY = (rowYPct / 100) * vh;

        if (labelEl) {
          if (item.align === 'left') {
            labelEl.style.left = `${marginPct}%`;
            labelEl.style.right = 'auto';
          } else {
            labelEl.style.left = 'auto';
            labelEl.style.right = `${marginPct}%`;
          }
          labelEl.style.top = `${labelY.toFixed(1)}px`;
          labelEl.style.opacity = calloutOpacity.toFixed(3);
        }

        if (anchors) {
          if (
            pathEl &&
            dotEl &&
            labelEl &&
            anchor &&
            anchor.visible &&
            drawPct > 0.01 &&
            calloutOpacity > 0.01
          ) {
            const ax = (anchor.xPct / 100) * vw;
            const ay = (anchor.yPct / 100) * vh;

            if (isMobile) {
              const labelCenterX = labelEl.offsetLeft + labelEl.offsetWidth * 0.5;
              const isTopRow = rowYPct < 50;
              const halfH = labelEl.offsetHeight * 0.5;
              const targetY = isTopRow ? labelY + halfH + 6 : labelY - halfH - 6;
              const elbowY = ay + (targetY - ay) * 0.55;
              pathEl.setAttribute(
                'd',
                `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${labelCenterX.toFixed(1)} ${elbowY.toFixed(1)} L ${labelCenterX.toFixed(1)} ${targetY.toFixed(1)}`
              );
            } else {
              const gapPx = 16;
              const labelStopX =
                item.align === 'left'
                  ? labelEl.offsetLeft + labelEl.offsetWidth + gapPx
                  : labelEl.offsetLeft - gapPx;
              const elbowX = ax + (labelStopX - ax) * 0.48;

              pathEl.setAttribute(
                'd',
                `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${elbowX.toFixed(1)} ${labelY.toFixed(1)} L ${labelStopX.toFixed(1)} ${labelY.toFixed(1)}`
              );
            }

            const totalLen = pathEl.getTotalLength();
            if (totalLen > 0) {
              if (drawPct >= 0.995) {
                pathEl.style.strokeDasharray = 'none';
                pathEl.style.strokeDashoffset = '0';
              } else {
                pathEl.style.strokeDasharray = `${totalLen.toFixed(1)} ${totalLen.toFixed(1)}`;
                pathEl.style.strokeDashoffset = (totalLen * (1 - drawPct)).toFixed(1);
              }
            }
            pathEl.style.opacity = '1';

            dotEl.setAttribute('cx', ax.toFixed(1));
            dotEl.setAttribute('cy', ay.toFixed(1));
            dotEl.style.opacity = Math.min(1, drawPct * 2.2).toFixed(3);
          } else if (pathEl && dotEl) {
            pathEl.style.opacity = '0';
            dotEl.style.opacity = '0';
          }
        } else if (pathEl && dotEl && (drawPct <= 0.01 || calloutOpacity <= 0.01)) {
          pathEl.style.opacity = '0';
          dotEl.style.opacity = '0';
        }
      });
    });

    return () => {
      disposed = true;
      removeEffect();
      window.removeEventListener('resize', handleResize);
      formation3D.dispose();
    };
  }, []);

  return (
    <section
      id="ship-voyage"
      ref={sectionRef}
      aria-label="UI/UX Design Process Interactive 3D Showcase"
      className="relative w-full h-[520vh] z-10"
    >
      <div className="sticky top-0 w-full h-screen overflow-hidden flex items-center justify-center">
        {/* 3D Animated Ocean Waves, Sailing Yacht, Inner Sphere & Underwater Dive Canvas */}
        <div
          ref={canvasMountRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {/* Quiet Top Stage Marker */}
        <div className="absolute top-[74px] sm:top-[78px] left-6 sm:left-12 right-6 sm:right-12 flex items-center justify-between font-pixel text-[10px] sm:text-xs uppercase pointer-events-none z-20">
          <span ref={stageLabelRef} className="opacity-75">
            01 // HORIZON
          </span>
          <span className="opacity-55 hidden sm:inline">UI/UX PROCESS</span>
        </div>

        {/* Optical Telescope Reticle Ring */}
        <div
          ref={telescopeOverlayRef}
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-20 opacity-0 will-change-transform"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 600 600"
            className="w-[min(78vw,460px)] h-[min(78vw,460px)] overflow-visible"
            fill="none"
          >
            <circle
              cx="300"
              cy="300"
              r="240"
              stroke="currentColor"
              strokeWidth="1"
              strokeOpacity="0.34"
            />
            <circle
              cx="300"
              cy="300"
              r="205"
              stroke="currentColor"
              strokeWidth="0.8"
              strokeDasharray="4 6"
              strokeOpacity="0.24"
            />

            {TELESCOPE_TICKS.map((t, i) => (
              <line
                key={`tick-${i}`}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke="currentColor"
                strokeWidth={t.isMajor ? '1.35' : '0.8'}
                strokeOpacity={t.isMajor ? '0.55' : '0.28'}
              />
            ))}

            <path
              d="M 255 270 L 255 255 L 270 255 M 330 255 L 345 255 L 345 270 M 255 330 L 255 345 L 270 345 M 330 345 L 345 345 L 345 330"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeOpacity="0.55"
            />
            <line
              x1="286"
              y1="300"
              x2="294"
              y2="300"
              stroke="currentColor"
              strokeWidth="1"
              strokeOpacity="0.45"
            />
            <line
              x1="306"
              y1="300"
              x2="314"
              y2="300"
              stroke="currentColor"
              strokeWidth="1"
              strokeOpacity="0.45"
            />
          </svg>
        </div>

        {/* Stage 1: Far Top-Right 75° Moving Boat Header */}
        <div
          ref={telescopeCopyRef}
          className="absolute bottom-[9%] sm:bottom-[11%] left-6 sm:left-12 right-6 sm:right-12 flex justify-center text-center pointer-events-none z-20 opacity-0 will-change-transform"
        >
          <h2 className="font-editorial text-2xl sm:text-4xl lg:text-5xl font-medium tracking-tight">
            Craft In Motion
          </h2>
        </div>

        {/* Stage 2: Scroll-Driven Speed Lines Racing Into the Boat */}
        <div
          ref={speedOverlayRef}
          className="absolute inset-0 pointer-events-none z-20 opacity-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 1000 1000"
            className="w-[min(98vw,780px)] h-[min(98vw,780px)] overflow-visible"
            fill="none"
          >
            <g ref={speedLinesGroupRef}>
              {SPEED_RAYS.map((ray, i) => (
                <line
                  key={`ray-${i}`}
                  x1={ray.x1}
                  y1={ray.y1}
                  x2={ray.x2}
                  y2={ray.y2}
                  stroke="currentColor"
                  strokeWidth={ray.strokeWidth}
                  strokeDasharray={ray.dashArray}
                  strokeOpacity="0.42"
                  strokeLinecap="round"
                />
              ))}
            </g>
          </svg>
          <h2 className="absolute bottom-[9%] sm:bottom-[11%] font-editorial text-xl sm:text-3xl font-medium tracking-tight">
            Closing The Distance
          </h2>
        </div>

        {/* Stage 3: SVG Leader Lines From Inner Sphere Nodes -> Design Help Headers */}
        <svg
          ref={svgOverlayRef}
          className="absolute inset-0 w-full h-full pointer-events-none z-20 opacity-0"
          fill="none"
          aria-hidden="true"
        >
          {DESIGN_HELP_CALLOUTS.map((item, idx) => (
            <g key={`leader-${item.key}`}>
              <path
                ref={(el) => {
                  pathRefs.current[idx] = el;
                }}
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="opacity-80"
              />
              <circle
                ref={(el) => {
                  dotRefs.current[idx] = el;
                }}
                r="3.8"
                fill="currentColor"
                stroke="var(--bg-color)"
                strokeWidth="1.5"
              />
            </g>
          ))}
        </svg>

        {/* Stage 3: Header-Only Design Help Callouts (Max 3 Words Each) */}
        <div className="absolute inset-0 pointer-events-none z-20">
          {DESIGN_HELP_CALLOUTS.map((item, idx) => (
            <div
              key={item.key}
              ref={(el) => {
                labelRefs.current[idx] = el;
              }}
              className={`absolute -translate-y-1/2 opacity-0 will-change-transform max-w-[44vw] sm:max-w-[260px] ${
                item.align === 'left' ? 'text-left' : 'text-right'
              }`}
            >
              <h3 className="font-editorial text-base sm:text-xl lg:text-2xl font-medium tracking-tight leading-tight">
                {item.title}
              </h3>
            </div>
          ))}
        </div>

        {/* Stage 3: Bottom Header */}
        <div
          ref={thesisRef}
          className="absolute bottom-[6%] left-6 right-6 text-center pointer-events-none z-20 opacity-0"
        >
          <h3 className="font-editorial text-sm sm:text-base font-medium tracking-tight opacity-75">
            How Design Helps
          </h3>
        </div>

        {/* Stage 4: Deep Underwater Under-Hull Header */}
        <div
          ref={diveOverlayRef}
          className="absolute bottom-[9%] sm:bottom-[11%] left-6 right-6 text-center pointer-events-none z-20 opacity-0"
        >
          <h2 className="font-editorial text-2xl sm:text-4xl lg:text-5xl font-medium tracking-tight">
            Beneath The Surface
          </h2>
        </div>
      </div>
    </section>
  );
}
