"""Synthetic Japanese smoke evaluation, not an estimate of population accuracy."""
import json
import argparse
import hashlib
from datetime import date
import os
from pathlib import Path
import platform
import subprocess
import time

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--device", choices=("auto", "cpu", "mps"), default="auto")
parser.add_argument("--output", type=Path, default=root / "docs/privacy-benchmark.json")
parser.add_argument("--stress", action="store_true")
parser.add_argument("--reference", type=Path)
args = parser.parse_args()
env = {**os.environ,
       "OMB_PRIVACY_DEVICE": args.device,
       "OMB_PRIVACY_CHECKPOINT": str(root / ".privacy-dev/checkpoint/original"),
       "TIKTOKEN_CACHE_DIR": str(root / ".privacy-dev/tiktoken")}
cases = [
    ("私は星野架空です。明日の予定を整理してください。", ["星野架空"]),
    ("氏名: 星野 架空\n会議は午後です。", ["星野 架空"]),
    ("住所は東京都架空区試験町1-2-3です。郵送先に使います。", ["東京都架空区試験町1-2-3"]),
    ("メールは hoshino@example.invalid です。返信案を作って。", ["hoshino@example.invalid"]),
    ("電話は090-1234-5678、口座番号は1234567です。", ["090-1234-5678", "1234567"]),
    ("APIキー: sk-proj-SYNTHETICKEY01234567890", ["sk-proj-SYNTHETICKEY01234567890"]),
    ("ツール結果: 担当者は架空田テスト、メールは tool@example.invalid。", ["架空田テスト", "tool@example.invalid"]),
    ("履歴: 山星試験さんは大阪府架空市検証町4-5-6に引っ越しました。", ["山星試験", "大阪府架空市検証町4-5-6"]),
    ("😀担当者は星野架空です。hoshino@example.invalid に連絡します。", ["星野架空", "hoshino@example.invalid"]),
    ("新製品の説明文を読みやすくしてください。", []),
    ("来週の会議では性能と価格を比較します。", []),
    ("連絡先はｈｏｓｈｉｎｏ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄです。", ["ｈｏｓｈｉｎｏ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ"]),
]
started = time.perf_counter()
payload_texts = ["model", "fixture", "messages", "role", "system", "content", "文章を読みやすく編集してください。"]
for i in range(8):
    payload_texts.extend(["role", "user", "content", f"担当者: 架空田検証{i}、メール: fixture{i}@example.invalid。検証用の会話履歴です。"])
requests = [[text] for text, _ in cases] * 2 + [payload_texts, payload_texts]
if args.stress:
    long_text = "会議の議題は製品の性能と価格の比較です。" * 250 + "\n氏名: 星野 架空\nメール: long.fixture@example.invalid"
    requests.extend([[long_text], [long_text]])
request = "\n".join(json.dumps({"texts": texts}, ensure_ascii=False) for texts in requests) + "\n"
result = subprocess.run([str(root / ".privacy-dev/venv/bin/python"), "-u", str(root / "scripts/privacy-worker.py")],
                        input=request, text=True, capture_output=True, env=env, timeout=300, check=True)
lines = [json.loads(line) for line in result.stdout.splitlines()]
ready, *all_runs = lines
if not ready.get("ready") or len(all_runs) != len(requests) or any("error" in r for r in all_runs):
    raise RuntimeError("benchmark failed")
runs = all_runs[:len(cases)]
warm = all_runs[len(cases):len(cases)*2]
payload_cold, payload_warm = all_runs[len(cases)*2:len(cases)*2+2]
if [r["spans"] for r in runs] != [r["spans"] for r in warm] or payload_cold["spans"] != payload_warm["spans"]:
    raise RuntimeError("cache changed detections")
observations = []
hits = total = 0
for (text, expected), run in zip(cases, runs):
    spans = run["spans"][0]
    utf16 = text.encode("utf-16-le")
    detected = [{**span, "text": utf16[span["start"]*2:span["end"]*2].decode("utf-16-le")} for span in spans]
    covered = []
    for value in expected:
        start = len(text[:text.index(value)].encode("utf-16-le")) // 2
        end = start + len(value.encode("utf-16-le")) // 2
        hit = all(any(s["start"] <= p < s["end"] for s in spans) for p in range(start, end))
        covered.append({"text": value, "fullyCovered": hit})
        hits += hit
        total += 1
    observations.append({"input": text, "expected": covered, "detected": detected,
          "elapsedMs": run["elapsedMs"], "rssBytes": run["rssBytes"]})
summary = lambda r: {k: v for k, v in r.items() if k != "spans"}
report = {"date": date.today().isoformat(), "machine": platform.machine(), "runtime": f"official OPF, {ready['device']}, 4 CPU threads, 4096-token windows; worker socket connections disabled; no quantization",
          "opfCommit": subprocess.check_output(["git", "-C", str(root / ".local-privacy-filter"), "rev-parse", "HEAD"], text=True).strip(),
          "ready": ready, "wallMs": round((time.perf_counter() - started)*1000),
          "peakRssBytes": max(r["rssBytes"] for r in all_runs),
          "maxObservedMpsAllocatedBytes": max(r["mpsAllocatedBytes"] for r in [ready, *all_runs]),
          "maxObservedMpsDriverBytes": max(r["mpsDriverBytes"] for r in [ready, *all_runs]),
          "coldCorpusMs": sum(r["elapsedMs"] for r in runs), "cachedCorpusMs": sum(r["elapsedMs"] for r in warm),
          "payloadFields": len(payload_texts), "payloadCold": summary(payload_cold), "payloadCached": summary(payload_warm),
          "cacheSpanParity": True, "fullyCovered": hits, "expectedSpans": total,
          "spanFingerprint": hashlib.sha256(json.dumps([r["spans"] for r in all_runs], sort_keys=True).encode()).hexdigest(),
          "cases": observations, "caution": "Small synthetic smoke corpus; this is not Japanese recall on real data. Includes misses and wrong categories. Rules and registered terms are evaluated separately."}
if args.stress:
    cold, cached = all_runs[-2:]
    if cold["spans"] != cached["spans"]:
        raise RuntimeError("long cache changed detections")
    os.environ["TIKTOKEN_CACHE_DIR"] = env["TIKTOKEN_CACHE_DIR"]
    import tiktoken
    report["longInput"] = {"characters": len(long_text), "tokens": len(tiktoken.get_encoding("o200k_base").encode(long_text)),
                           "cold": summary(cold), "cached": summary(cached), "cacheSpanParity": True}
if args.reference:
    reference = json.loads(args.reference.read_text())
    report["referenceSpanParity"] = report["spanFingerprint"] == reference["spanFingerprint"]
target = args.output
target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "cases"}, ensure_ascii=False, indent=2))
