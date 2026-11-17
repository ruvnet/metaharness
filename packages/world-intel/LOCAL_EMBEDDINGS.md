# Explicit local BGE embeddings

CLI: `world-intel-ts --data-dir ./data --embedding-model-dir /absolute/model-dir`
(`--allow-writes` separately enables write tools.) The async
`createLocalBgeEmbedding(directory)` API uses optional Transformers.js 4.3.2
for tokenization and ONNX Runtime Web WASM for inference. No Python runtime,
server, model download, remote inference or automatic model installation occurs.

## Pinned assets

The adapter rejects unknown model/config/tokenizer SHA256 hashes. Supported MIT
model exports are:

- BAAI/bge-small-en-v1.5, revision
  `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` (official fp32, 133,093,490 bytes).
- Qdrant/bge-small-en-v1.5-onnx-Q, revision
  `aa8f8b060edb00e03bfdd08813a2949946c8ba55` (FastEmbed0.7.0's actual export,
  66,465,124 bytes). Its `model_optimized.onnx` is placed at `onnx/model.onnx`.

Provide config.json, tokenizer.json, tokenizer_config.json and onnx/model.onnx
from the same pinned export. SHA256 manifests are in `src/local-embedding.ts`.
The embedding identity includes export repository and revision, so archives cannot
silently mix fp32 and quantized embeddings. Injected test runtimes with unknown
assets are explicitly labeled fixture-unverified-bge, not BAAI.

Uses 2,000 Unicode codepoints with no prefix, tokenizer truncation at 512 tokens,
CLS pooling and L2 normalization. Packaged WASM assets load locally, single-threaded
without worker proxy. Remote model loads and filesystem cache writes are disabled.
Close the provider with `dispose()`.

## Validation

Both official exports executed locally on actual WASM. Six reference vectors and
token-ID sequences were generated offline using pinned FastEmbed0.7.0 and the
exact Qdrant export, including empty, Unicode, news, markets and truncated long
text. The development-only Python oracle is not shipped or required by tests.

`tests/bge-golden.test.ts` verifies:
- Exact input IDs, attention masks and token type IDs for all six texts.
- All384 vector elements within absolute error0.0003.
- Cosine agreement above0.999999.
- All six corpus rankings against all six queries match the reference.

Measured maximum element error was0.000229258; lowest cosine was0.999999346.
This is tolerance-based parity on six fixtures, NOT bit-identical vectors or
proof for every input. Run with `WORLD_INTEL_BGE_ASSET_DIR=/local/qdrant-model`
set explicitly. Without local assets the integration suite is visibly skipped;
it never downloads weights. Ordinary unit tests also run a tiny in-memory ONNX
identity model through the actual packaged WASM runtime.

## Licenses and sources

Transformers.js: Apache-2.0. ONNX Runtime: MIT. Both model exports: MIT.
Weights remain outside the repository. Preserve their MIT notices when distributing.

- https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
- https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/tree/aa8f8b060edb00e03bfdd08813a2949946c8ba55
- https://github.com/qdrant/fastembed/tree/v0.7.0
- https://huggingface.co/docs/transformers.js/en/api/env
