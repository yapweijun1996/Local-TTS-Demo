import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import app as sidecar


class _FakeTensor:
    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return np.array([0.1, 0.1], dtype="float32")


class _FakePipeline:
    def __init__(self, phonemes_per_cjk: int = 3):
        self.phonemes_per_cjk = phonemes_per_cjk
        self.received = None

    def g2p(self, text: str):
        length = sum(
            self.phonemes_per_cjk if "\u4e00" <= char <= "\u9fff" else 1
            for char in text
        )
        return "x" * length, None

    def __call__(self, chunks, **_kwargs):
        self.received = chunks
        for _chunk in chunks:
            yield SimpleNamespace(audio=_FakeTensor())


class SafeGraphemeChunkTests(unittest.TestCase):
    def assert_safe_chunks(self, pipeline, chunks):
        self.assertTrue(chunks)
        self.assertTrue(all(len(chunk) <= sidecar.KOKORO_MAX_GRAPHEME_CHARS for chunk in chunks))
        self.assertTrue(
            all(
                len(pipeline.g2p(chunk)[0]) <= sidecar.KOKORO_MAX_PHONEMES
                for chunk in chunks
            )
        )

    def test_long_chinese_paragraph_is_split(self):
        pipeline = _FakePipeline()
        text = "甲" * 300

        chunks = sidecar._safe_grapheme_chunks(pipeline, text)

        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        self.assert_safe_chunks(pipeline, chunks)

    def test_sentence_boundaries_are_preferred_and_preserved(self):
        pipeline = _FakePipeline()
        first = "甲" * 150 + "。"
        second = "乙" * 150 + "？"
        third = "丙" * 150 + "！\n"
        text = first + second + third + "尾部"

        chunks = sidecar._safe_grapheme_chunks(pipeline, text)

        self.assertEqual("".join(chunks), text)
        self.assertEqual(chunks[:2], [first, second])
        self.assertEqual(chunks[2], third + "尾部")
        self.assert_safe_chunks(pipeline, chunks)

    def test_more_than_510_phonemes_are_not_truncated(self):
        pipeline = _FakePipeline()
        text = "中文" * 110
        original_phoneme_length = len(pipeline.g2p(text)[0])

        chunks = sidecar._safe_grapheme_chunks(pipeline, text)

        self.assertGreater(original_phoneme_length, sidecar.KOKORO_MAX_PHONEMES)
        self.assertEqual("".join(chunks), text)
        self.assertEqual(sum(len(pipeline.g2p(chunk)[0]) for chunk in chunks), original_phoneme_length)
        self.assert_safe_chunks(pipeline, chunks)

    def test_english_and_mixed_text_remain_lossless(self):
        pipeline = _FakePipeline()
        text = "Hello, 世界！This is mixed text; 第二句。\nThe tail remains."

        chunks = sidecar._safe_grapheme_chunks(pipeline, text)

        self.assertEqual("".join(chunks), text)
        self.assert_safe_chunks(pipeline, chunks)

    def test_synthesize_passes_verified_chunk_list_to_kpipeline(self):
        pipeline = _FakePipeline()
        text = "甲" * 220

        with patch.dict(sidecar._state, {"pipeline": pipeline, "error": None, "last_generation_ms": None}):
            response = sidecar.synthesize(sidecar.SynthesizeRequest(text=text))

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(pipeline.received, list)
        self.assertEqual("".join(pipeline.received), text)
        self.assert_safe_chunks(pipeline, pipeline.received)

    def test_trim_edge_silence_keeps_short_padding_only(self):
        source = np.zeros(sidecar.SAMPLE_RATE, dtype="float32")
        source[sidecar.SAMPLE_RATE // 4 : sidecar.SAMPLE_RATE * 3 // 4] = 0.2

        trimmed = sidecar._trim_edge_silence(source)

        self.assertLess(trimmed.size, source.size)
        self.assertGreater(trimmed.size, sidecar.SAMPLE_RATE // 2)
        self.assertLessEqual(trimmed.size, sidecar.SAMPLE_RATE * 3 // 4)


if __name__ == "__main__":
    unittest.main()
