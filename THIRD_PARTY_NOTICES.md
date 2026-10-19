# Licensing and third-party notices

Encore Karaoke is distributed as a combined work under GNU GPL version 3 only.
See [LICENSE.txt](LICENSE.txt) for the complete license. Copyright (c) 2026 Encore Karaoke Labs.
This program comes with no warranty. You may redistribute and modify it under GPL-3.0.
Existing MIT-licensed material retains the notice reproduced below; this does not
make the combined work, or the Nightingale-derived files, MIT-licensed.

## Nightingale scoring

Copyright: rzru and the Nightingale contributors.
Project: https://github.com/rzru/nightingale
Pinned revision: ab3304bb2f36fe8046013a97cd1d498b7a0fb6ca
License: GPL-3.0 (distributed here under GPL-3.0-only).

Files adapted into `src/hosted/scoring/`:

- `client/src/features/playback/lib/pitch/constants.ts`
- `client/src/features/playback/lib/pitch/detect.ts`
- `client/src/features/playback/lib/pitch/state.ts`
- `app-core/analyzer/stems.py` (Demucs calculation adapted into the live worker)

Modifications dated October 19, 2026: transpiled to JavaScript, changed imports
for Encore's modules, and connected through an Encore-specific reference and
playback adapter. The adapter adds asynchronous preparation, MIDI references,
0–100 room score normalization, and replay/seek accounting. These adaptations
are also distributed under GPL-3.0-only. Nightingale's React hooks and full-file analyzer are not included. Its Demucs
normalization and residual instrumental calculation are adapted in
`server/separation_worker.py` for live overlapping windows. Reference analysis and microphone detection use
Pitchy, licensed under MIT. Pitchy and fft.js license notices are reproduced
below and copied into the built browser distribution.

## Original Encore MIT notice

MIT License

Copyright (c) 2026 Encore Karaoke Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pitchy (MIT)

Copyright 2018-2021 Ian Johnson

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## fft.js (MIT)

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2017.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

## Maintained Demucs fork

Source: https://github.com/adefossez/demucs
Revision: 2883f3db65617d6d178c6ed10d869dc14e44e59b (version 4.1.0).
The worker uses its htdemucs model; it does not install the archived
facebookresearch implementation. The Python dependency source URL is pinned in
`server/separation-requirements.txt`.

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.