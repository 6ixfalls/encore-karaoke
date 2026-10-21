# SPDX-License-Identifier: GPL-3.0-only
# Adapted from rzru/nightingale app-core/analyzer/stems.py, revision
# ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca. Copyright Nightingale contributors.
# Modified 2026-10-19: bounded live PCM windows, context trimming and pipe outputs;
# uses the maintained adefossez/demucs fork. See THIRD_PARTY_NOTICES.md.
"""stdin: 44.1 kHz stereo float32; stdout: backing L/R + mono vocal PCM; fd 3: vocal NDJSON."""
import base64
import json
import os
import re
import sys

RATE = 44100
CHUNK = RATE * 8
CONTEXT = RATE


def pcm_windows(stream):
    """Bounded lookahead; emit each input sample exactly once, including EOF."""
    import numpy as np
    left = np.empty((0, 2), dtype="<f4")
    pending = b""
    eof = False
    while True:
        target = (CHUNK + CONTEXT) * 8
        while len(pending) < target and not eof:
            data = stream.read(target - len(pending))
            if data:
                pending += data
            else:
                eof = True
        if len(pending) % 8:
            raise ValueError("truncated_stereo_pcm")
        samples = np.frombuffer(pending, dtype="<f4").reshape(-1, 2)
        if not len(samples):
            break
        count = min(CHUNK, len(samples))
        yield np.concatenate((left, samples)), len(left), count
        left = samples[max(0, count - CONTEXT):count].copy()
        pending = pending[count * 8:]


def separate_window(wav, model, device):
    """Nightingale's Demucs normalization and residual instrumental calculation."""
    import torch
    from demucs.apply import apply_model
    ref = wav.mean(0)
    scale = ref.abs().max().clamp(min=1e-8)
    mean = ref.mean()
    with torch.inference_mode():
        sources = apply_model(model, ((wav - mean) / scale)[None],
                              device=device, shifts=1, overlap=0.25, progress=False)[0]
    vocals = sources[model.sources.index("vocals")] * scale + mean
    return vocals, wav - vocals


def main():
    import numpy as np
    import torch
    from demucs.pretrained import get_model
    torch.set_num_threads(int(os.environ.get("SEPARATION_THREADS", "2")))
    device = os.environ.get("SEPARATION_DEVICE", "cpu")
    if not re.fullmatch(r"cpu|mps|cuda(?::\d+)?", device):
        raise ValueError("invalid_separation_device")
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable; install CUDA PyTorch and expose the NVIDIA GPU")
    # Match Nightingale: its Demucs path does not use MPS.
    actual_device = torch.device("cpu" if device == "mps" else device)
    # Keep stdout exclusively binary even if model download emits diagnostics.
    from contextlib import redirect_stdout
    with redirect_stdout(sys.stderr):
        model = get_model("htdemucs")
        model.to(actual_device).eval()
    metadata = os.fdopen(3, "w", buffering=1)
    start = 0
    for samples, left, count in pcm_windows(sys.stdin.buffer):
        wav = torch.from_numpy(np.ascontiguousarray(samples.T)).to(actual_device)
        vocals, backing = separate_window(wav, model, actual_device)
        vocals = vocals[:, left:left + count].mean(0).detach().cpu().numpy().astype("<f4")
        backing = backing[:, left:left + count].detach().cpu().numpy().T.astype("<f4")
        metadata.write(json.dumps({"start": start, "samples": count,
                                  "vocals": base64.b64encode(vocals.tobytes()).decode("ascii")}) + "\n")
        mixed = np.column_stack((backing, vocals)).astype("<f4")
        sys.stdout.buffer.write(mixed.tobytes())
        sys.stdout.buffer.flush()
        start += count
        if start > RATE * 600:
            raise ValueError("separation_duration_limit")
    metadata.close()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
