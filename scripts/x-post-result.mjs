import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function xPostUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid X post URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) throw new Error("Invalid X post URL");
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/u);
  if (!match || match[1].toLowerCase() === "i") throw new Error("Use the canonical author/status/id URL shown by X");
  return { url: `https://x.com/${match[1]}/status/${match[2]}`, author: match[1].toLowerCase(), id: match[2] };
}

function body(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000) throw new Error("Missing or oversized visible post text");
  return value;
}

export function formatXPosts(input, { otherReplies = false, otherQuotes = false } = {}) {
  const source = xPostUrl(input?.sourceUrl);
  if (!Array.isArray(input.posts) || input.posts.length > 200) throw new Error("Expected at most 200 observed posts");
  const seen = new Map();
  let excluded = 0;
  for (const row of input.posts) {
    const post = xPostUrl(row?.url);
    if (!["root", "reply", "quote"].includes(row.kind)) throw new Error("Invalid observed relationship");
    if (row.contextRootId !== source.id || (row.kind === "root" && post.id !== source.id)) {
      excluded++;
      continue;
    }
    if (post.author !== source.author && !(row.kind === "reply" && otherReplies) && !(row.kind === "quote" && otherQuotes)) {
      excluded++;
      continue;
    }
    const result = { url: post.url, author: post.author, text: body(row.text), kind: row.kind };
    if (row.time !== undefined) {
      if (typeof row.time !== "string" || row.time.length > 80) throw new Error("Invalid visible timestamp");
      result.time = row.time;
    }
    if (row.quote !== undefined) result.quote = { url: xPostUrl(row.quote.url).url, text: body(row.quote.text) };
    const previous = seen.get(post.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(result)) throw new Error("Conflicting observations for the same post; recheck the page");
    seen.set(post.id, result);
  }
  const posts = [...seen.values()];
  if (!posts.some(post => post.url === source.url && post.kind === "root")) throw new Error("Original post was not observed");
  return {
    sourceUrl: source.url, author: source.author,
    scope: { otherReplies, otherQuotes, embeddedQuotes: true },
    coverage: "partial", reason: "Rendered browser observations only; hidden replies and quote search completeness are not verified",
    mediaContent: "not_collected", excluded, posts,
  };
}

async function main() {
  const { values } = parseArgs({ options: { "other-replies": { type: "boolean" }, "other-quotes": { type: "boolean" } }, strict: true });
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 2_000_000) throw new Error("Observation input exceeds 2 MB");
  }
  const result = formatXPosts(JSON.parse(data), { otherReplies: values["other-replies"] === true, otherQuotes: values["other-quotes"] === true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("X result validation failed; no result was exported. Check the URL, observed relationships and input limits.\n"); process.exitCode = 1; });
}
