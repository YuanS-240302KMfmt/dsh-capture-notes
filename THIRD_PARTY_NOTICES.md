# Third-party notices

`dsh-capture-notes` itself is licensed under Apache-2.0. It uses or bundles the
following third-party components; their own licenses continue to apply.

| Component | License | Notes |
|---|---|---|
| [NAudio](https://github.com/naudio/NAudio) | MIT | `lib/NAudio.dll`; full text in `lib/NAudio.LICENSE.txt` |
| [sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | ASR runtime, installed under `runtime/` (not committed) |
| [sherpa-onnx-win-x64](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | native runtime, installed under `runtime/` (not committed) |
| [opencc-js](https://github.com/nk2028/opencc-js) | MIT AND Apache-2.0 | simplified/traditional conversion, installed under `runtime/` (not committed) |
| [@ffmpeg-installer/ffmpeg](https://github.com/kribblo/node-ffmpeg-installer) | LGPL-2.1 | ffmpeg binary, installed under `runtime/` (not committed) |
| [@ffprobe-installer/ffprobe](https://github.com/SimenB/ffprobe-installer) | LGPL-2.1 | ffprobe binary, installed under `runtime/` (not committed) |
| SenseVoice model | Upstream license | Model files are not distributed in this repository; see the upstream FunAudioLLM/SenseVoice project |
| Silero VAD model | Upstream license | Model files are not distributed in this repository; see the upstream Silero VAD project |

## Distribution note

The repository does **not** commit `models/` or `runtime/`. If you redistribute a
package that includes ffmpeg/ffprobe binaries or model files, keep the upstream
license texts and notices, and comply with their terms (including LGPL-2.1 for
the ffmpeg/ffprobe builds). Do not relicense those components under Apache-2.0.
