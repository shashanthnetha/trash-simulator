// Display case for the rare finds: vitrine grid (silhouettes for pieces not
// found yet), per-kind statistics, a 3D inspect viewer (drag to rotate, wheel
// to zoom) and the readable bottle letters on aged paper.
//
// The inspect viewer and the thumbnail baker each run their own small
// WebGLRenderer that is created on demand and fully disposed again – the
// game's renderer and scene are never touched from here.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type {
  CollectibleDef,
  CollectibleKind,
} from "../game/collectibles-data";
import {
  COLLECTIBLES,
  COLLECTIBLE_BY_ID,
  COLLECTIBLE_KINDS,
  KIND_NAMES,
} from "../game/collectibles-data";
import {
  buildCollectibleModel,
  disposeCollectibleModel,
} from "../game/collectibles-models";
import { useGame } from "../game/state";
import { formatCents } from "../game/types";
import { Chip, EmptyNote, Panel, SectionHead } from "./MenuUi";

// ---------------------------------------------------------------------------
// Shared scene dressing for thumbnails and the inspect viewer
// ---------------------------------------------------------------------------

function dressScene(scene: THREE.Scene): void {
  scene.environmentIntensity = 0.45;
  scene.add(new THREE.HemisphereLight(0xdbeaf4, 0x3a3226, 0.45));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.15);
  key.position.set(1.5, 2.2, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd6ee, 0.4);
  rim.position.set(-1.8, 1.4, -1.6);
  scene.add(rim);
}

/** Soft radial contact shadow under the piece (owned by the model group). */
function addContactShadow(model: THREE.Group, radius: number): void {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, "rgba(0,0,0,0.42)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 3.2, radius * 3.2),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.0005;
  disc.renderOrder = 0;
  model.add(disc);
}

/** Centre the model on the origin; bounding-sphere radius + height. */
function frameModel(model: THREE.Group): { r: number; h: number } {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  addContactShadow(model, Math.max(size.x, size.z) * 0.5);
  model.position.set(-center.x, -box.min.y, -center.z);
  return { r: Math.max(0.01, size.length() * 0.5), h: size.y };
}

// ---------------------------------------------------------------------------
// Thumbnails (baked once per variant, cached for the session)
// ---------------------------------------------------------------------------

const thumbCache = new Map<string, string>();

function useThumbnails(ids: string[]): number {
  const [tick, setTick] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    const missing =
      key.length > 0 ? key.split(",").filter((id) => !thumbCache.has(id)) : [];
    if (missing.length === 0) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(176, 176);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    for (const id of missing) {
      const scene = new THREE.Scene();
      scene.environment = envRT.texture;
      dressScene(scene);
      const model = buildCollectibleModel(id);
      const fm = frameModel(model);
      scene.add(model);
      const cam = new THREE.PerspectiveCamera(30, 1, 0.005, 10);
      cam.position
        .set(0.7, 0.8, 1)
        .normalize()
        .multiplyScalar(fm.r * 3.1);
      cam.position.y += fm.h * 0.4;
      cam.lookAt(0, fm.h * 0.42, 0);
      renderer.render(scene, cam);
      thumbCache.set(id, renderer.domElement.toDataURL("image/png"));
      disposeCollectibleModel(model);
    }
    room.dispose();
    envRT.dispose();
    pmrem.dispose();
    renderer.dispose();
    setTick((t) => t + 1);
  }, [key]);
  return tick;
}

// ---------------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------------

/** Kind silhouette for pieces not found yet. */
function Silhouette({ kind }: { kind: CollectibleKind }) {
  const stroke = "rgba(255,255,255,0.16)";
  const fill = "rgba(255,255,255,0.05)";
  return (
    <svg
      viewBox="0 0 64 64"
      className="h-20 w-20"
      role="img"
      aria-label="Not yet found"
    >
      {kind === "fossil" && (
        <path
          d="M32 12 a20 20 0 1 1 -20 20 a15 15 0 1 0 15 -15 a10 10 0 1 1 -10 10 a5 5 0 1 0 5 -5"
          fill="none"
          stroke={stroke}
          strokeWidth="4"
          strokeLinecap="round"
        />
      )}
      {kind === "coin" && (
        <>
          <circle
            cx="32"
            cy="32"
            r="21"
            fill={fill}
            stroke={stroke}
            strokeWidth="3"
          />
          <circle
            cx="32"
            cy="32"
            r="13"
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            strokeDasharray="3 3"
          />
        </>
      )}
      {kind === "bottle" && (
        <path
          d="M27 8 h10 v4 h-2 v8 c0 3 6 6 6 12 v20 a4 4 0 0 1 -4 4 h-10 a4 4 0 0 1 -4 -4 v-20 c0 -6 6 -9 6 -12 v-8 h-2 z"
          fill={fill}
          stroke={stroke}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      )}
      {kind === "jewellery" && (
        <>
          <circle
            cx="32"
            cy="38"
            r="14"
            fill="none"
            stroke={stroke}
            strokeWidth="5"
          />
          <path
            d="M26 20 l6 -8 l6 8 l-6 5 z"
            fill={fill}
            stroke={stroke}
            strokeWidth="2"
          />
        </>
      )}
    </svg>
  );
}

function fmtFound(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function VitrineCell({
  def,
  foundAt,
  onInspect,
}: {
  def: CollectibleDef;
  foundAt: number | undefined;
  onInspect: (id: string) => void;
}) {
  const found = foundAt != null;
  const thumb = thumbCache.get(def.id);
  return (
    <button
      type="button"
      disabled={!found}
      onClick={() => onInspect(def.id)}
      className={`relative rounded-xl border p-3 text-left transition ${
        found
          ? "border-white/12 bg-white/[0.05] hover:border-[rgba(242,160,7,0.5)] hover:bg-white/[0.08]"
          : "cursor-default border-white/[0.06] bg-black/25"
      }`}
    >
      <div className="flex h-24 items-center justify-center">
        {found && thumb ? (
          <img
            src={thumb}
            alt={def.name}
            className="h-24 w-24 object-contain drop-shadow-[0_6px_10px_rgba(0,0,0,0.5)]"
            draggable={false}
          />
        ) : (
          <Silhouette kind={def.kind} />
        )}
      </div>
      {found ? (
        <div className="mt-1.5">
          <div className="truncate text-[13px] font-semibold text-white/90">
            {def.name}
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-2">
            <span className="ts-mono text-[12px] text-emerald-300/90">
              {formatCents(def.valueCents)}
            </span>
            <span className="text-[10px] text-white/35">
              {fmtFound(foundAt)}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-1.5">
          <div className="ts-label">Not yet found</div>
          <div className="mt-0.5 text-[11px] text-white/25">— — —</div>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inspect viewer (live 3D, drag to rotate, wheel to zoom)
// ---------------------------------------------------------------------------

function InspectOverlay({
  id,
  foundAt,
  onClose,
}: {
  id: string;
  foundAt: number;
  onClose: () => void;
}) {
  const def = COLLECTIBLE_BY_ID[id];
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showLetter, setShowLetter] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envRT = pmrem.fromScene(room, 0.04);
    scene.environment = envRT.texture;
    dressScene(scene);
    const model = buildCollectibleModel(id);
    const fm = frameModel(model);
    const r = fm.r;
    scene.add(model);

    const cam = new THREE.PerspectiveCamera(32, 1, 0.005, 20);
    const lookY = fm.h * 0.5;
    let yaw = 0.7;
    let pitch = 0.42;
    let dist = r * 2.9;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.008;
      pitch = Math.max(
        -0.4,
        Math.min(1.25, pitch + (e.clientY - lastY) * 0.006),
      );
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      el.style.cursor = "grab";
      if (el.hasPointerCapture(e.pointerId))
        el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.max(
        r * 1.4,
        Math.min(r * 5.5, dist * (1 + e.deltaY * 0.0012)),
      );
    };
    el.style.cursor = "grab";
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      if (!dragging) yaw += dt * 0.25; // slow shop-window turn
      const cp = Math.cos(pitch);
      cam.position.set(
        Math.sin(yaw) * cp * dist,
        lookY + Math.sin(pitch) * dist,
        Math.cos(yaw) * cp * dist,
      );
      cam.lookAt(0, lookY, 0);
      renderer.render(scene, cam);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      disposeCollectibleModel(model);
      room.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      mount.removeChild(el);
    };
  }, [id]);

  if (!def) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close inspection"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[#02060a]/80"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(6,14,20,0.82) 0%, rgba(1,4,7,0.95) 75%)",
        }}
      />
      <div className="relative flex h-[min(640px,92vh)] w-[min(980px,95vw)] flex-col gap-3 md:flex-row">
        <div
          ref={mountRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10"
          style={{
            background:
              "radial-gradient(ellipse at 50% 42%, rgba(46,64,78,0.55) 0%, rgba(8,14,19,0.9) 72%)",
          }}
        >
          <div className="ts-label pointer-events-none absolute bottom-3 left-0 right-0 text-center opacity-60">
            Drag to rotate · scroll to zoom
          </div>
        </div>

        <aside className="menu-panel flex w-full shrink-0 flex-col rounded-2xl p-4 text-white md:w-72">
          <div className="hazard-rail mb-3 h-[4px] w-full rounded" />
          <div className="ts-label">{KIND_NAMES[def.kind]}</div>
          <div className="ts-display mt-1 text-[24px]">{def.name}</div>
          <div className="mt-3 flex items-center gap-2">
            <Chip tone="amber">Appraised</Chip>
            <span className="ts-mono text-[15px] text-emerald-300">
              {formatCents(def.valueCents)}
            </span>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-white/65">
            {def.desc}
          </p>
          <div className="ts-mono mt-3 text-[11px] text-white/40">
            Found on {fmtFound(foundAt)}
          </div>
          <div className="mt-auto space-y-2 pt-4">
            {def.letter && (
              <button
                type="button"
                onClick={() => setShowLetter(true)}
                className="w-full rounded-lg bg-[var(--amber)] px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-[#17130a] transition hover:brightness-110"
              >
                Read the letter
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-[12px] font-semibold uppercase tracking-wide transition hover:bg-white/20"
            >
              Back to the case
            </button>
          </div>
        </aside>
      </div>

      {showLetter && def.letter && (
        <LetterOverlay
          title={def.name}
          text={def.letter}
          onClose={() => setShowLetter(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The letter, on aged paper
// ---------------------------------------------------------------------------

function LetterOverlay({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  // torn-edge outline, stable per letter
  const clip = useMemo(() => {
    const pts: string[] = [];
    let h = 0;
    for (let i = 0; i < title.length; i++)
      h = (h * 31 + title.charCodeAt(i)) | 0;
    const jit = (k: number) => {
      h = (Math.imul(h ^ (h >>> 13), 0x5bd1e995) + k) | 0;
      return ((h >>> 8) % 100) / 100;
    };
    const N = 14;
    for (let i = 0; i <= N; i++) pts.push(`${(i / N) * 100}% ${jit(i) * 1.6}%`);
    for (let i = 1; i <= N; i++)
      pts.push(`${100 - jit(i + 40) * 1.8}% ${(i / N) * 100}%`);
    for (let i = 1; i <= N; i++)
      pts.push(`${100 - (i / N) * 100}% ${100 - jit(i + 80) * 1.7}%`);
    for (let i = 1; i < N; i++)
      pts.push(`${jit(i + 120) * 1.8}% ${100 - (i / N) * 100}%`);
    return `polygon(${pts.join(",")})`;
  }, [title]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4">
      <div
        className="relative w-[min(560px,94vw)]"
        style={{ transform: "rotate(-0.7deg)" }}
      >
        <div
          className="scroll-thin max-h-[76vh] overflow-y-auto px-8 py-7"
          style={{
            clipPath: clip,
            background:
              "linear-gradient(155deg, #f0e4c4 0%, #e6d3a4 48%, #d9c28c 100%)",
            boxShadow:
              "0 30px 90px rgba(0,0,0,0.7), inset 0 0 70px rgba(122,92,44,0.28)",
            color: "#3b3020",
          }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.22em] opacity-60"
            style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
          >
            Recovered letter · {title}
          </div>
          <p
            className="mt-4 whitespace-pre-line text-[15.5px] leading-[1.75]"
            style={{
              fontFamily:
                "'Segoe Script', 'Bradley Hand', 'Comic Sans MS', cursive",
            }}
          >
            {text}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="absolute -bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-white/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-white shadow-lg backdrop-blur transition hover:bg-white/25"
        >
          Fold it away
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function CollectionTab() {
  const collection = useGame((s) => s.collection);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const foundIds = useMemo(
    () => COLLECTIBLES.filter((c) => collection[c.id] != null).map((c) => c.id),
    [collection],
  );
  useThumbnails(foundIds);

  const found = foundIds.length;
  const totalValue = COLLECTIBLES.reduce(
    (sum, c) => sum + (collection[c.id] != null ? c.valueCents : 0),
    0,
  );

  return (
    <div className="space-y-3">
      <Panel className="p-4">
        <SectionHead
          label="Display case"
          hint="Rare finds washed up along the coast – each one exists exactly once. Watch for a faint sparkle in the sand."
          right={
            <div className="text-right">
              <div className="ts-mono text-[13px] text-white/70">
                {found} / {COLLECTIBLES.length} found
              </div>
              {found > 0 && (
                <div className="ts-mono mt-0.5 text-[12px] text-emerald-300">
                  {formatCents(totalValue)}
                </div>
              )}
            </div>
          }
        />
        <div className="flex flex-wrap gap-1.5">
          {COLLECTIBLE_KINDS.map((k) => {
            const defs = COLLECTIBLES.filter((c) => c.kind === k);
            const own = defs.filter((c) => collection[c.id] != null).length;
            return (
              <Chip
                key={k}
                tone={
                  own === defs.length ? "good" : own > 0 ? "amber" : "plain"
                }
              >
                {KIND_NAMES[k]} {own}/{defs.length}
              </Chip>
            );
          })}
        </div>
        {found === 0 && (
          <div className="mt-3">
            <EmptyNote>
              Nothing in the case yet. Rare pieces are scattered along the
              beach: fossils near the waterline and the rocky east end, coins
              deep in the dunes, bottles right at the wave line and jewellery on
              the dry sand.
            </EmptyNote>
          </div>
        )}
      </Panel>

      {COLLECTIBLE_KINDS.map((kind) => {
        const defs = COLLECTIBLES.filter((c) => c.kind === kind);
        return (
          <Panel key={kind} className="p-4">
            <SectionHead
              label={KIND_NAMES[kind]}
              right={
                <span className="ts-mono text-[12px] text-white/50">
                  {defs.filter((c) => collection[c.id] != null).length} /{" "}
                  {defs.length}
                </span>
              }
            />
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {defs.map((def) => (
                <VitrineCell
                  key={def.id}
                  def={def}
                  foundAt={collection[def.id]}
                  onInspect={setInspectId}
                />
              ))}
            </div>
          </Panel>
        );
      })}

      {inspectId != null && collection[inspectId] != null && (
        <InspectOverlay
          id={inspectId}
          foundAt={collection[inspectId]}
          onClose={() => setInspectId(null)}
        />
      )}
    </div>
  );
}
