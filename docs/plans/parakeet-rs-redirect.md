# Redirect: Parakeet dictation → parakeet-rs on Theorem (owner, 2026-11-17)

**Owner's instruction:** the in-browser Parakeet dictation work in this
worktree (`src/lib/speech/parakeet.ts`, `dictation.ts`, `mic-worklet.js`,
`parakeet.js` + `onnxruntime-web` deps) should instead use
**[parakeet-rs](https://github.com/altunenes/parakeet-rs)** running on
Theorem (the Rust server), not a browser ONNX model.

This note was left by the assistant-ui enrichment session, which could not
locate the live session that authored the Parakeet files. If you are that
session, or are picking this up, read this first.

## Why the redirect is sound

- `parakeet-rs` (altunenes, MIT OR Apache-2.0) is **Rust** — NVIDIA Parakeet
  ASR on ONNX Runtime or pure-Rust `burn` (CPU/Metal/wgpu). It runs
  server-side, not in the browser. Current crate v0.4.4.
- The browser approach (`parakeet.js` 1.4.4) fetches a ~1.24 GB fp16 encoder
  into IndexedDB and runs WebGPU/WASM. It already fails in this dev server:
  `onnxruntime-web`'s `ort-wasm-simd-threaded.jsep.{mjs,wasm}` are not exported
  under Vite's SSR conditions, which 500s every story route. Moving ASR to
  Theorem removes the browser model download, the SSR break, and the
  SharedArrayBuffer/WebGPU constraints.
- Theorem already owns execution and credentials server-side (the same
  reason MCP stays server-side). Server-side ASR fits that model: the page
  streams mic audio, Theorem transcribes, the transcript returns.

## Shape of the change

1. **Theorem (Rust):** add `parakeet-rs` to the server, expose a dictation
   endpoint (streaming chunks or buffered utterance). Models: TDT
   `parakeet-tdt-0.6b-v3` (25 langs, offline) or a streaming variant
   (EOU / Nemotron / Unified) for live dictation. `from_pretrained` on a
   downloaded HF folder; 16 kHz mono.
2. **UI:** keep the mic capture (`mic-worklet.js`, 16 kHz mono chunks) and
   the `DictationAdapter` contract, but replace the `parakeet.js` transcriber
   with a transport that sends audio to Theorem and receives interim/final
   text. Keep the `WebSpeechDictationAdapter` fallback for offline/no-server.
3. **Drop** `parakeet.js` and `onnxruntime-web` from `package.json` once the
   server path lands; that also fixes the SSR 500.

## Status of the files here

Uncommitted, authored by another session (not the enrichment work):
`src/lib/speech/{parakeet.ts,dictation.ts,mic-worklet.js}`,
`src/routes/settings/companions.tsx`, face `mic.level` signal edits, and the
`parakeet.js`/`onnxruntime-web` deps. The enrichment session deliberately did
not commit or alter these.
