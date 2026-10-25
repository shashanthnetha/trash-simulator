// Trash Simulator – touch controls (virtual stick + buttons)
import { useEffect, useRef, useState } from "react";
import {
  addTouchLook,
  fireTouchAction,
  setTouchHorn,
  setTouchSprint,
  setTouchStick,
} from "../game/input";
import { useGame } from "../game/state";

const STICK_R = 64;

export function TouchUI() {
  const st = useGame();
  const [sprint, setSprint] = useState(false);
  const [horn, setHorn] = useState(false);
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const stickId = useRef<number | null>(null);
  const lookId = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });

  useEffect(() => {
    return () => {
      setTouchStick(0, 0);
      setTouchSprint(false);
      setTouchHorn(false);
    };
  }, []);

  // Leaving the jeep hides the horn button – release it so it cannot stick.
  useEffect(() => {
    if (!st.inJeep) {
      setTouchHorn(false);
      setHorn(false);
    }
  }, [st.inJeep]);

  const onStickDown = (e: React.PointerEvent) => {
    e.preventDefault();
    stickId.current = e.pointerId;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    moveStick(e);
  };
  const moveStick = (e: React.PointerEvent) => {
    if (e.pointerId !== stickId.current || !stickRef.current) return;
    const r = stickRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = (e.clientX - cx) / STICK_R;
    let dy = (e.clientY - cy) / STICK_R;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    setTouchStick(dx, -dy);
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(${dx * STICK_R * 0.5}px, ${dy * STICK_R * 0.5}px)`;
    }
  };
  const onStickUp = (e: React.PointerEvent) => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null;
    setTouchStick(0, 0);
    if (knobRef.current)
      knobRef.current.style.transform = "translate(0px, 0px)";
  };

  const onLookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = e.pointerId;
    lookLast.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onLookMove = (e: React.PointerEvent) => {
    if (e.pointerId !== lookId.current) return;
    addTouchLook(
      e.clientX - lookLast.current.x,
      e.clientY - lookLast.current.y,
    );
    lookLast.current = { x: e.clientX, y: e.clientY };
  };
  const onLookUp = (e: React.PointerEvent) => {
    if (e.pointerId === lookId.current) lookId.current = null;
  };

  const Btn = ({
    label,
    action,
    className,
  }: {
    label: string;
    action: () => void;
    className?: string;
  }) => (
    <button
      type="button"
      className={`touch-btn pointer-events-auto ${className ?? ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        action();
      }}
    >
      {label}
    </button>
  );

  /** Press and hold – the horn sounds for as long as the button is held. */
  const hornDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setHorn(true);
    setTouchHorn(true);
  };
  const hornUp = () => {
    setHorn(false);
    setTouchHorn(false);
  };

  const canGrab = st.promptGrab;

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Look area: right half of the screen */}
      <div
        className="pointer-events-auto absolute bottom-0 right-0 top-0 w-1/2"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* Stick, bottom left */}
      <div
        ref={stickRef}
        className="touch-stick pointer-events-auto bottom-8 left-6 h-32 w-32"
        onPointerDown={onStickDown}
        onPointerMove={moveStick}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      >
        <div ref={knobRef} className="knob transition-transform duration-75" />
      </div>

      {/* Sprint toggle above the stick */}
      <Btn
        label="Sprint"
        className={`absolute bottom-44 left-10 h-12 w-12 text-[10px] font-semibold uppercase tracking-wide ${sprint ? "ring-2 ring-emerald-300" : ""}`}
        action={() => {
          const v = !sprint;
          setSprint(v);
          setTouchSprint(v);
        }}
      />

      {/* Action cluster, bottom right */}
      <div className="absolute bottom-8 right-6 flex flex-col items-end gap-3">
        <div className="flex items-end gap-3">
          <Btn
            label={st.inJeep ? "Exit" : "Enter"}
            className="h-14 w-14 text-[10px] font-semibold uppercase leading-tight tracking-wide"
            action={() => fireTouchAction("vehicle")}
          />
          <Btn
            label="Use"
            className="h-14 w-14 text-[10px] font-semibold uppercase leading-tight tracking-wide"
            action={() => fireTouchAction("action")}
          />
        </div>
        <div className="flex items-end gap-3">
          {/* Tool swap appears once the detector is owned (marketplace). */}
          {!st.inJeep && (st.upgrades.detector ?? 0) >= 1 && (
            <Btn
              label="Tool"
              className="h-14 w-14 text-[10px] font-semibold uppercase leading-tight tracking-wide"
              action={() => fireTouchAction("toolCycle")}
            />
          )}
          {!st.inJeep && (
            <Btn
              label="Jump"
              className="h-14 w-14 text-[10px] font-semibold uppercase leading-tight tracking-wide"
              action={() => fireTouchAction("jump")}
            />
          )}
          {st.inJeep && (
            <button
              type="button"
              className={`touch-btn pointer-events-auto h-14 w-14 text-[10px] font-semibold uppercase leading-tight tracking-wide ${
                horn ? "ring-2 ring-amber-300" : ""
              }`}
              onPointerDown={hornDown}
              onPointerUp={hornUp}
              onPointerCancel={hornUp}
              onLostPointerCapture={hornUp}
            >
              Horn
            </button>
          )}
          {/* Grabbing is impossible from the driver's seat – hide the button */}
          {!st.inJeep && (
            <Btn
              label="Grab"
              className={`h-20 w-20 text-[12px] font-bold uppercase tracking-wide ${canGrab ? "ring-2 ring-emerald-300" : "opacity-70"}`}
              action={() => fireTouchAction("primary")}
            />
          )}
        </div>
      </div>

      {/* Top right: pause + menu */}
      <div className="absolute right-3 top-16 flex gap-2">
        <Btn
          label="Menu"
          className="h-11 w-11 text-[10px] font-semibold uppercase tracking-wide"
          action={() => fireTouchAction("menu")}
        />
        <Btn
          label="Pause"
          className="h-11 w-11 text-[10px] font-semibold uppercase tracking-wide"
          action={() => fireTouchAction("pause")}
        />
      </div>
    </div>
  );
}
