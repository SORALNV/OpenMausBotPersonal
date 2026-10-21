import type { NativeClient } from "./direct-codex-client.ts";

/** Creates a separate native history. It does not resume, rename, or synchronize the source conversation. */
export async function createRelaySession(client: NativeClient, sourceThreadId: string, name: string): Promise<{ threadId: string; sourceThreadId: string; name: string }> {
  if (!/^[\w-]{1,100}$/.test(sourceThreadId) || !name.trim() || name.length > 120 || [...name].some(c => c.charCodeAt(0) < 32)) throw new Error("An explicit source and session name are required");
  const source = await client.request("thread/read", { threadId: sourceThreadId });
  if (source.thread?.id !== sourceThreadId || source.thread.status?.type === "active") throw new Error("The source must exist and be idle before copying");
  const created = await client.request("thread/fork", { threadId: sourceThreadId, excludeTurns: true });
  const threadId = created.thread?.id;
  if (typeof threadId !== "string" || threadId === sourceThreadId || created.thread.forkedFromId !== sourceThreadId) throw new Error("A separate inherited session was not confirmed; do not retry automatically");
  try {
    await client.request("thread/name/set", { threadId, name: name.trim() });
    return { threadId, sourceThreadId, name: name.trim() };
  } catch {
    throw new Error(`Session ${threadId} was created but naming failed; inspect it before creating another`);
  } finally { await client.request("thread/unsubscribe", { threadId }).catch(() => {}); }
}
