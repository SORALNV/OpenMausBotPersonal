// Not dir="auto": that algorithm skips descendants carrying their own dir, so a blockquote or table of per-block
// directions falls back to LTR. JS regexes cannot match Bidi_Class, so these are the blocks Unicode reserves for
// right-to-left letters.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const strong = /\p{Letter}/u.exec(value);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function blockText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return "";
  return (node.children ?? []).map(blockText).join("");
}

export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

