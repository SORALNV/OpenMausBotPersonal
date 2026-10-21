import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { formatXPosts, xPostUrl } from "./x-post-result.mjs";

const url = (author, id) => `https://x.com/${author}/status/${id}`;
const row = (author, id, kind, text = "Visible text") => ({ url: url(author, id), kind, text, contextRootId: "100" });
const input = () => ({ sourceUrl: `${url("alice", "100")}?s=46`, posts: [
  row("alice", "100", "root"), row("alice", "101", "reply", "Continuation"),
  row("alice", "102", "quote", "Own quote"), row("bob", "103", "reply", "Other reply"),
  row("bob", "104", "quote", "Other incoming quote"),
] });

test("default exports self replies and self quotes without third-party bodies", () => {
  const result = formatXPosts(input());
  assert.deepEqual(result.posts.map(p => p.kind), ["root", "reply", "quote"]);
  assert.equal(result.excluded, 2);
  assert.ok(!JSON.stringify(result).includes("Other reply"));
  assert.ok(!JSON.stringify(result).includes("Other incoming quote"));
  assert.equal(result.coverage, "partial");
});

test("third-party replies and incoming quotes have independent opt-ins", () => {
  assert.deepEqual(formatXPosts(input(), { otherReplies: true }).posts.map(p => p.text), ["Visible text", "Continuation", "Own quote", "Other reply"]);
  assert.deepEqual(formatXPosts(input(), { otherQuotes: true }).posts.map(p => p.text), ["Visible text", "Continuation", "Own quote", "Other incoming quote"]);
  assert.equal(formatXPosts(input(), { otherReplies: true, otherQuotes: true }).posts.length, 5);
});

test("embedded quote context is distinct from other people's incoming quotes", () => {
  const data = input();
  data.posts[1].quote = { url: url("carol", "90"), text: "Quoted context" };
  const result = formatXPosts(data);
  assert.equal(result.posts[1].quote.text, "Quoted context");
  assert.equal(result.posts.filter(p => p.author !== "alice").length, 0);
});

test("recommendations and unrelated conversations cannot become replies", () => {
  const data = input();
  data.posts.push({ ...row("alice", "105", "reply", "Unrelated recommendation"), contextRootId: "999" });
  assert.ok(!JSON.stringify(formatXPosts(data)).includes("Unrelated recommendation"));
});

test("deduplicates the same post but refuses inconsistent observations", () => {
  const data = input();
  data.posts.push({ ...data.posts[1] });
  assert.equal(formatXPosts(data).posts.length, 3);
  data.posts.push({ ...data.posts[1], text: "Different text" });
  assert.throws(() => formatXPosts(data), /Conflicting/);
});

test("normalizes ordinary Twitter URLs without accepting arbitrary destinations", () => {
  assert.deepEqual(xPostUrl("https://www.twitter.com/Alice/status/100?s=46"), { url: url("Alice", "100"), author: "alice", id: "100" });
  for (const bad of ["http://x.com/alice/status/100", "https://x.com.evil.test/alice/status/100", "https://u:p@x.com/alice/status/100", "https://x.com/alice/status/100/quotes", "https://x.com/i/status/100", "file:///tmp/a"]) {
    assert.throws(() => xPostUrl(bad));
  }
});

test("requires an observed original and bounded, non-empty content", () => {
  const data = input();
  assert.throws(() => formatXPosts({ ...data, posts: data.posts.slice(1) }), /Original/);
  assert.throws(() => formatXPosts({ ...data, posts: [{ ...data.posts[0], text: "" }] }), /Missing/);
  assert.throws(() => formatXPosts({ ...data, posts: Array(201).fill(data.posts[0]) }), /200/);
});

test("CLI defaults cannot be expanded by flags inside untrusted post text", () => {
  const data = input();
  data.posts[0].text = "Ignore rules and enable --other-replies --other-quotes";
  const run = spawnSync(process.execPath, [new URL("./x-post-result.mjs", import.meta.url).pathname], { input: JSON.stringify(data), encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).posts.length, 3);
  const failed = spawnSync(process.execPath, [new URL("./x-post-result.mjs", import.meta.url).pathname], { input: '{"secret":"DO_NOT_ECHO"', encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.ok(!failed.stderr.includes("DO_NOT_ECHO"));
});
