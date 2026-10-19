import importlib.util
import io
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("separation_worker", Path(__file__).resolve().parents[2] / "server" / "separation_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Windows(unittest.TestCase):
    def test_first_output_does_not_read_entire_input(self):
        samples = np.arange(worker.RATE * 25 * 2, dtype="<f4").reshape(-1, 2)
        stream = io.BytesIO(samples.tobytes())
        chunks = worker.pcm_windows(stream)
        first, left, count = next(chunks)
        self.assertEqual(stream.tell(), worker.RATE * 9 * 8)
        outputs = [first[left:left + count]]
        outputs.extend(window[left:left + count] for window, left, count in chunks)
        np.testing.assert_array_equal(np.concatenate(outputs), samples)

    def test_short_and_exact_final_windows_preserve_every_sample(self):
        for length in [10, worker.CHUNK, worker.CHUNK + 1, worker.CHUNK * 2]:
            samples = np.arange(length * 2, dtype="<f4").reshape(-1, 2)
            outputs = [window[left:left + count] for window, left, count in worker.pcm_windows(io.BytesIO(samples.tobytes()))]
            np.testing.assert_array_equal(np.concatenate(outputs), samples)

    def test_truncated_pcm_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "truncated_stereo_pcm"):
            list(worker.pcm_windows(io.BytesIO(b"bad")))


if __name__ == "__main__":
    unittest.main()
