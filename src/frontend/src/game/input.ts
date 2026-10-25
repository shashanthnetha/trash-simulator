// Trash Simulator – input: keyboard, mouse (pointer lock) and touch
import { useGame } from "./state";

export type GameAction =
  | "primary"
  | "vehicle"
  | "action"
  | "jump"
  | "menu"
  /** Open the menu directly on the Inventory tab (I). */
  | "inventory"
  /** Open the menu directly on the Market tab (M). */
  | "market"
  /** Equip the litter picker (1 / Numpad 1). */
  | "tool1"
  /** Equip the metal detector (2 / Numpad 2). */
  | "tool2"
  /** Cycle the equipped tool (mouse wheel, touch Tool button). */
  | "toolCycle"
  | "pause";

export interface InputCallbacks {
  onLook: (dx: number, dy: number) => void;
  onAction: (a: GameAction) => void;
  onLockChange: (locked: boolean) => void;
}

// ---------------- Touch bridge (written by TouchUI.tsx) ----------------
const touch = { x: 0, y: 0, sprint: false, horn: false };
let touchSink: InputCallbacks | null = null;

export function setTouchStick(x: number, y: number): void {
  touch.x = Math.max(-1, Math.min(1, x));
  touch.y = Math.max(-1, Math.min(1, y));
}
export function setTouchSprint(b: boolean): void {
  touch.sprint = b;
}
export function setTouchHorn(b: boolean): void {
  touch.horn = b;
}
export function addTouchLook(dx: number, dy: number): void {
  if (!touchSink) return;
  const s = useGame.getState().settings;
  const k = 0.0042 * s.sensitivity;
  touchSink.onLook(dx * k, dy * k * (s.invertY ? -1 : 1));
}
export function fireTouchAction(a: GameAction): void {
  touchSink?.onAction(a);
}

export function detectTouch(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
    !window.matchMedia("(pointer: fine)").matches
  );
}

// ---------------- Main input ----------------
export class InputManager {
  private canvas: HTMLCanvasElement;
  private cb: InputCallbacks;
  private keys = new Set<string>();
  private disposed = false;
  /** Wheel delta accumulator – trackpads report many tiny notches. */
  private wheelAcc = 0;

  constructor(canvas: HTMLCanvasElement, cb: InputCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    touchSink = cb;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("contextmenu", this.onCtx);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (useGame.getState().isTouch || this.locked) return;
    // Chrome ≥ 113 returns a promise that rejects when the request falls into
    // the Escape-key cooldown – harmless, but it would log a page error.
    const p = this.canvas.requestPointerLock?.() as unknown;
    if (p instanceof Promise) p.catch(() => undefined);
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Held state of the horn key (H) or the touch horn button. */
  hornHeld(): boolean {
    return this.keys.has("KeyH") || touch.horn;
  }

  /** Movement vector from keyboard + touch stick. */
  getMove(): { f: number; r: number; sprint: boolean } {
    let f = 0;
    let r = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) f += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) f -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) r += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) r -= 1;
    f += touch.y;
    r += touch.x;
    f = Math.max(-1, Math.min(1, f));
    r = Math.max(-1, Math.min(1, r));
    const sprint =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || touch.sprint;
    return { f, r, sprint };
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    this.keys.add(e.code);
    switch (e.code) {
      case "Space":
        e.preventDefault();
        this.cb.onAction("jump");
        break;
      case "KeyE":
        this.cb.onAction("vehicle");
        break;
      case "KeyF":
        this.cb.onAction("action");
        break;
      case "Tab":
        e.preventDefault();
        this.cb.onAction("menu");
        break;
      case "KeyI":
        this.cb.onAction("inventory");
        break;
      case "Digit1":
      case "Numpad1":
        this.cb.onAction("tool1");
        break;
      case "Digit2":
      case "Numpad2":
        this.cb.onAction("tool2");
        break;
      case "Escape":
        this.cb.onAction("pause");
        break;
      default:
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onLockChange = (): void => {
    const locked = this.locked;
    useGame.getState().setPointerLocked(locked);
    this.cb.onLockChange(locked);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = useGame.getState().settings;
    const k = 0.0021 * s.sensitivity;
    this.cb.onLook(e.movementX * k, e.movementY * k * (s.invertY ? -1 : 1));
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const st = useGame.getState();
    if (st.isTouch) return;
    if (!this.locked) {
      if (st.screen === "game" && !st.paused && !st.menuOpen)
        this.requestLock();
      return;
    }
    this.cb.onAction("primary");
  };

  private onCtx = (e: Event): void => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY;
    if (Math.abs(this.wheelAcc) >= 60) {
      this.wheelAcc = 0;
      this.cb.onAction("toolCycle");
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (touchSink === this.cb) touchSink = null;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("contextmenu", this.onCtx);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.releaseLock();
  }
}
