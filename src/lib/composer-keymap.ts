import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { imeComposing } from "./send-key";

export const COMPOSER_KEYMAP_KEY = "omb-personal-composer-keymap";
export const COMPOSER_CHORDS = ["enter", "shift-enter", "mod-enter"] as const;
export type ComposerChord = typeof COMPOSER_CHORDS[number];
export type ComposerAction = "queue" | "steer" | "newline";
export type ComposerKeymap = Record<ComposerAction, ComposerChord>;
export const DEFAULT_COMPOSER_KEYMAP: ComposerKeymap = { queue: "enter", steer: "mod-enter", newline: "shift-enter" };
const actions: ComposerAction[] = ["queue", "steer", "newline"];
let cachedRaw: string | null | undefined;
let cached: ComposerKeymap = DEFAULT_COMPOSER_KEYMAP;
const listeners = new Set<() => void>();
export function parseComposerKeymap(raw: string | null): ComposerKeymap {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || actions.some(action => !COMPOSER_CHORDS.includes(value[action])) || new Set(actions.map(action => value[action])).size !== 3) return DEFAULT_COMPOSER_KEYMAP;
    return { queue: value.queue, steer: value.steer, newline: value.newline };
  } catch { return DEFAULT_COMPOSER_KEYMAP; }
}
function snapshot(): ComposerKeymap {
  try {
    const raw = localStorage.getItem(COMPOSER_KEYMAP_KEY);
    if (raw !== cachedRaw) { cachedRaw = raw; cached = parseComposerKeymap(raw); }
  } catch {}
  return cached;
}
function notify() { for (const listener of listeners) listener(); }
function storageChanged(event: StorageEvent) { if (event.key === COMPOSER_KEYMAP_KEY || event.key === null) { cachedRaw = undefined; notify(); } }
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", storageChanged);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("storage", storageChanged); };
}
export function setComposerBinding(action: ComposerAction, chord: ComposerChord): void {
  const previous = snapshot();
  const other = actions.find(candidate => candidate !== action && previous[candidate] === chord);
  cached = { ...previous, ...(other ? { [other]: previous[action] } : {}), [action]: chord };
  cachedRaw = JSON.stringify(cached);
  try { localStorage.setItem(COMPOSER_KEYMAP_KEY, cachedRaw); } catch {}
  notify();
}
export function useComposerKeymap(): ComposerKeymap { return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_COMPOSER_KEYMAP); }
export function composerKeyAction(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "keyCode">, map: ComposerKeymap): ComposerAction | undefined {
  if (event.key !== "Enter" || imeComposing(event) || event.altKey || event.shiftKey && (event.metaKey || event.ctrlKey)) return;
  const chord = event.metaKey || event.ctrlKey ? "mod-enter" : event.shiftKey ? "shift-enter" : "enter";
  return actions.find(action => map[action] === chord);
}

export function handleComposerKeys(event: ReactKeyboardEvent<HTMLTextAreaElement>, map: ComposerKeymap, options: {
  busy: boolean; text: string; onText(text: string): void; onSend(delivery: "queue" | "steer"): void;
}): boolean {
  const action = composerKeyAction(event.nativeEvent, map);
  if (!action) return false;
  event.preventDefault();
  if (action !== "newline") options.onSend(action === "steer" && options.busy ? "steer" : "queue");
  else {
    const input = event.currentTarget, start = input.selectionStart;
    options.onText(options.text.slice(0, start) + "\n" + options.text.slice(input.selectionEnd));
    requestAnimationFrame(() => { if (input.isConnected) input.setSelectionRange(start + 1, start + 1); });
  }
  return true;
}
