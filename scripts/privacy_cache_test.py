import unittest
from privacy_cache import DetectionCache


class DetectionCacheTest(unittest.TestCase):
    def test_exact_inputs_and_duplicate_fields(self):
        calls = []
        def infer(text):
            calls.append(text)
            return [{"start": 0, "end": 1, "label": "private_person"}]
        cache = DetectionCache()
        first, stats = cache.detect(["架空", "架空", "架空 ", "😀架空"], infer)
        self.assertEqual(calls, ["架空", "架空 ", "😀架空"])
        self.assertEqual(stats, {"cacheHits": 1, "inferredTexts": 3})
        first[0][0]["end"] = 99
        second, stats = cache.detect(["架空"], infer)
        self.assertEqual(second[0][0]["end"], 1)
        self.assertEqual(stats["inferredTexts"], 0)

    def test_entry_limit_and_lru(self):
        cache = DetectionCache(max_entries=2)
        cache.detect(["a", "b", "a", "c"], lambda _: [])
        self.assertEqual(list(cache.entries), ["a", "c"])
        _, stats = cache.detect(["b"], lambda _: [])
        self.assertEqual(stats["inferredTexts"], 1)

    def test_byte_limit_and_oversize(self):
        cache = DetectionCache(max_bytes=8)
        cache.detect(["aa", "bb", "cc", "x" * 10], lambda _: [])
        self.assertLessEqual(cache.bytes, 8)
        self.assertNotIn("aa", cache.entries)
        self.assertNotIn("x" * 10, cache.entries)

    def test_empty_result_is_cached_and_failures_are_not(self):
        cache = DetectionCache()
        cache.detect(["normal"], lambda _: [])
        def fail(_):
            raise ValueError("detector failed")
        self.assertEqual(cache.detect(["normal"], fail)[0], [[]])
        for _ in range(2):
            with self.assertRaises(ValueError):
                cache.detect(["unknown"], fail)
        self.assertNotIn("unknown", cache.entries)


if __name__ == "__main__":
    unittest.main()
