"""Process-local, exact-input detection cache; never persisted or logged."""
from collections import OrderedDict
import json


class DetectionCache:
    def __init__(self, max_bytes=4 * 1024 * 1024, max_entries=2048):
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.entries = OrderedDict()
        self.bytes = 0

    def detect(self, texts, infer):
        results = []
        hits = inferred = 0
        for text in texts:
            if text in self.entries:
                spans, size = self.entries.pop(text)
                self.entries[text] = (spans, size)
                hits += 1
            else:
                spans = infer(text)
                inferred += 1
                size = len(text.encode("utf-8")) + len(json.dumps(spans).encode("utf-8"))
                if size <= self.max_bytes and self.max_entries > 0:
                    while self.entries and (self.bytes + size > self.max_bytes or len(self.entries) >= self.max_entries):
                        _, (_, evicted_size) = self.entries.popitem(last=False)
                        self.bytes -= evicted_size
                    self.entries[text] = (tuple(dict(span) for span in spans), size)
                    self.bytes += size
            results.append([dict(span) for span in spans])
        return results, {"cacheHits": hits, "inferredTexts": inferred}
