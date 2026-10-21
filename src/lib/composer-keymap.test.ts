// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { composerKeyAction, DEFAULT_COMPOSER_KEYMAP, parseComposerKeymap, COMPOSER_KEYMAP_KEY, setComposerBinding } from "./composer-keymap";
afterEach(() => vi.unstubAllGlobals());

it("separates queue, newline and steer, including IME and unsupported modifiers", () => {
  const press = (options: KeyboardEventInit = {}) => composerKeyAction(new KeyboardEvent("keydown", { key: "Enter", ...options }), DEFAULT_COMPOSER_KEYMAP);
  expect(press()).toBe("queue"); expect(press({ shiftKey: true })).toBe("newline");
  expect(press({ metaKey: true })).toBe("steer"); expect(press({ ctrlKey: true })).toBe("steer");
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { metaKey: true, shiftKey: true }]) expect(press(options)).toBeUndefined();
});
it("migrates invalid preferences to safe distinct defaults and swaps colliding bindings", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  expect(parseComposerKeymap('{"queue":"enter","steer":"enter","newline":"enter"}')).toEqual(DEFAULT_COMPOSER_KEYMAP);
  localStorage.removeItem(COMPOSER_KEYMAP_KEY);
  setComposerBinding("steer", "enter");
  const map = parseComposerKeymap(localStorage.getItem(COMPOSER_KEYMAP_KEY));
  expect(map).toEqual({ queue: "mod-enter", steer: "enter", newline: "shift-enter" });
  localStorage.removeItem(COMPOSER_KEYMAP_KEY);
});
