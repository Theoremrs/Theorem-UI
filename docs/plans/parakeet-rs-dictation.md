# Dictation on Theorem: parakeet-rs (pure-Rust burn)

Owner (2026-11-17): take over the stalled side-chat's Parakeet work; drop the
in-browser `parakeet.js` ONNX model for **parakeet-rs on Theorem**, via the
**pure-Rust burn** route (Theorem already uses burn). Curious about RAM.

## What exists

- UI (this worktree, uncommitted, from the stalled session):
  `src/lib/speech/{parakeet.ts,dictation.ts,mic-worklet.js}`, a
  `DictationAdapter` (`parakeetDictation`/`dictationAdapter`) with a
  `WebSpeechDictationAdapter` fallback, `useMicLevel` for the face, and
  `settings/companions.tsx` to start the model download. Deps `parakeet.js`
  1.4.4 + `onnxruntime-web`. The browser fetches a ~2.5 GB fp32 TDT encoder
  into IndexedDB; `onnxruntime-web`'s wasm breaks Vite SSR (500s stories).
- Theorem server (`rustyredcore_THG`): axum HTTP + tonic gRPC, routes merged
  in `router.rs::build_router`; the connectors API
  (`theorem_chat_connectors.rs`, `BASE_ROUTE = /api/chat/v1/connectors`,
  `routes() -> Router<AppState>`, `AuthContext`) is the closest analog.
  burn **0.21.0** is already a workspace dep (`rustyred-thg-ml`,
  `theorem-harness-runtime`), with wgpu/metal/cubecl features.

## The compatibility constraint (verified)

parakeet-rs 0.4.4 pins **burn `=0.22.0`** (its `src/burn_backend/generated`
is codegen'd for that exact version) and `burn-store =0.22.0`. Theorem uses
burn 0.21.0. These are different major-minor versions; cargo will keep both
in the graph (they are separate crates), but they must not share types.
parakeet-rs's burn backend is self-contained (generated code + its own burn
deps), so it can coexist with Theorem's 0.21 burn as long as we do not try
to pass burn tensors between them. **Decision: add parakeet-rs as an
isolated dependency of a new `theorem-dictation` crate, feature-gated, with
`default-features = false` + `metal` (Apple) / `wgpu` / `burn` (CPU). No
ONNX Runtime is built.** The two burn versions coexist; we never mix their
types.

## RAM (the owner's question)

parakeet-rs burn reads **fp32** ONNX files (int8/int4 are refused on burn).
Model sizes on HF (altunenes/parakeet-rs):
- TDT `parakeet-tdt-0.6b-v3` (25 langs, offline): encoder ~2.48 GB +
  decoder_joint ~73 MB ≈ **2.55 GB fp32 weights**, all in memory, plus
  activations. This is the multilingual offline model; it transcribes a
  whole utterance (up to ~4-5 min), not live streaming.
- Streaming EOU `realtime_eou_120m-v1-onnx` (eng, 120M): encoder ~461 MB +
  decoder ~21 MB ≈ **~483 MB fp32**, 160 ms chunks — live dictation.
- Nemotron streaming en 0.6B / 3.5 multilingual 0.6B: ~1.2-1.5 GB fp32,
  560 ms chunks, live.

So: **live dictation wants a streaming model** (EOU ~0.5 GB, or Nemotron
~1.2 GB for multilingual), not the 2.55 GB offline TDT. burn keeps weights
in memory once loaded; a lazy, lazily-unloaded model means RAM is spent only
while dictation is enabled. On Apple silicon `metal` is markedly faster than
ORT CPU (TDT 10.2s→2.4s on M3); the first run compiles/tunes kernels
(seconds), cached on disk. The server already validates a memory envelope
(`runtime_watchdog::MemoryEnvelope`); the dictation model must fit inside it
or be gated off by default.

## Design

1. **Theorem: `theorem-dictation` crate** (new, feature-gated `dictation`):
   - parakeet-rs `default-features=false`, `metal` on Apple, `wgpu`
     elsewhere, `burn` CPU fallback; `apple-amx` for CPU matmul.
   - A lazily-loaded transcriber behind a `DictationEngine` trait; model
     dir from config/env (downloaded HF folder), provider chosen by target.
   - Streaming model (EOU or Nemotron) for live dictation; `transcribe_chunk`
     per 160/560 ms chunk, `flush` on stop.
2. **Theorem: HTTP endpoint** `/api/chat/v1/dictation` (WebSocket for live
   chunks + interim text; a buffered POST fallback for a whole utterance).
   Auth via `AuthContext` like connectors. Feature-gated so a server without
   the model/deps returns a clear "not served" problem (the UI already
   handles `isNotServed`).
3. **UI: replace the transcriber, keep the contract.** `dictation.ts` keeps
   `mic-worklet.js` capture (16 kHz mono chunks + level), `useMicLevel`, the
   `DictationAdapter` shape and the WebSpeech fallback; the parakeet.js
   `StatefulStreamingTranscriber` is replaced by a WebSocket transport to
   Theorem. Drop `parakeet.ts`, `parakeet.js`, `onnxruntime-web`; the
   companions settings become "enable server dictation" (no browser
   download). This also fixes the SSR 500.
4. **Verification:** a Rust unit test transcribing a committed 16 kHz WAV
   fixture through the burn engine (CPU, small model or a stub), the
   endpoint's auth/not-served behavior, and the UI adapter against a fake
   socket. Live mic→server→composer acceptance on the dev stack.

## Open decisions (owner)

- **Model:** streaming EOU (eng, ~0.5 GB) vs Nemotron 3.5 (40 langs,
  ~1.2 GB) vs offline TDT (25 langs, ~2.55 GB, not live). Recommendation:
  Nemotron 3.5 streaming for multilingual live dictation, EOU if English-only
  and RAM-tight. The offline TDT is the wrong shape for live dictation.
- **RAM gate:** load lazily on first dictation and unload after idle, vs
  keep resident. Recommendation: lazy load + idle unload, inside the memory
  envelope.
- **Transport:** WebSocket (live interim) vs buffered POST (simpler, final
  only). Recommendation: WebSocket for the live interim the composer shows.

## Status

Plan recorded; implementation next. The stalled session's browser-ONNX files
are preserved uncommitted until the server path replaces them.
