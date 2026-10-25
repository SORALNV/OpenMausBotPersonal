// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeOmpSettings } from "./NativeOmpSettings";
const mocked = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocked.api }));
afterEach(() => { vi.unstubAllGlobals(); mocked.api.mockReset(); });

async function mount(failFirstConnection = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const session = { id: "native-project", name: "架空の研究", directory: "/fixture/native/project", file: "/fixture/native/project/session.jsonl", running: false, shared: false };
  const state = { bindings: [{ botId: "pi", enabled: true }], threadTargets: {}, sessionIds: { old: "native-old" }, states: { old: "idle" } };
  const bot = { id: "pi", name: "RaspberryPi", threadId: "old", tasks: [{ threadId: "old", title: "元の会話" }] };
  let attempts = 0;
  mocked.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/bots?messages=0") return { bots: [bot] };
    if (path === "/api/native-omp") return state;
    if (path.startsWith("/api/native-omp/sessions")) return init?.method === "POST" ? { session } : { sessions: [session] };
    if (path === "/api/native-omp/threads") {
      const body = JSON.parse(init!.body as string);
      if (failFirstConnection && attempts++ === 0) throw Error("架空の一時接続エラー");
      if (body.newThreadTitle) { bot.threadId = "new"; bot.tasks.push({ threadId: "new", title: body.newThreadTitle }); }
      return { threadId: body.newThreadTitle ? "new" : body.threadId, session };
    }
    throw Error("Unexpected API path");
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const onOpenThread = vi.fn();
  await act(async () => root.render(createElement(NativeOmpSettings, { onOpenThread })));
  const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  const select = async (label: string, value: string) => act(async () => {
    const element = host.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
    element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return { host, root, click, select, onOpenThread, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("selects an existing native session or OMP management mode for the chosen OMB thread", async () => {
  const f = await mount();
  try {
    await f.click("OMPセッション一覧を読み込む");
    await f.select("OMPセッション", "native-project"); await f.select("OMP接続方式", "manager");
    await f.click("このスレッドを接続");
    const call = mocked.api.mock.calls.find(([path]) => path === "/api/native-omp/threads")!;
    expect(JSON.parse(call[1].body)).toEqual({ botId: "pi", threadId: "old", kind: "manager", sessionId: "native-project" });
    expect(f.host.textContent).toContain("接続しました");
    await f.click("選択したスレッドを開く"); expect(f.onOpenThread).toHaveBeenCalledWith("pi", "old");
  } finally { await f.close(); }
});

it("retries a failed new-thread connection using the saved session and the same request ID", async () => {
  const f = await mount(true);
  try {
    await act(async () => {
      const input = f.host.querySelector('[aria-label="OMPプロジェクト名"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "架空の研究"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await f.select("OMP作成後の接続", "new-thread");
    await f.click("名前付きOMPセッションを作成"); expect(f.host.textContent).toContain("一時接続エラー");
    await f.click("名前付きOMPセッションを作成");
    const creates = mocked.api.mock.calls.filter(([path, init]) => path === "/api/native-omp/sessions" && init?.method === "POST");
    const connections = mocked.api.mock.calls.filter(([path]) => path === "/api/native-omp/threads").map(([, init]) => JSON.parse(init.body));
    expect(creates).toHaveLength(1); expect(connections).toHaveLength(2);
    expect(connections[0].requestId).toBe(connections[1].requestId);
    expect(connections[0]).toMatchObject({ newThreadTitle: "架空の研究", sessionId: "native-project" });
    expect((f.host.querySelector('[aria-label="OMP接続のスレッド"]') as HTMLSelectElement).value).toBe("new");
  } finally { await f.close(); }
});
