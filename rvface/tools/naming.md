# Tensor naming, manifest schema, and fixture conventions

## Tensor names in `.safetensors`

Converted weights keep the **original PyTorch `state_dict` keys verbatim**,
with exactly one normalization: a leading `module.` (DataParallel) prefix is
stripped. Nothing is renamed, reordered, fused, or transposed; `BatchNorm`
`num_batches_tracked` buffers are kept (0-dim `int64`, ignorable). This makes
every converted file bit-diffable against `torch.load` of the original and
keeps the Rust loaders' name mapping in one place (the Rust side).

Examples per model:

| Model | Example keys |
|---|---|
| `detector-slim320` | `base_net.0.0.weight`, `base_net.0.1.running_var`, `extras.0.0.weight`, `classification_headers.0.0.bias`, `regression_headers.3.weight` |
| `landmark-mfn68` | `conv1.conv.weight`, `conv1.prelu.weight`, `conv_3.model.0.conv_dw.bn.running_mean`, `output_layer.conv_6_dw.conv.weight`, `output_layer.linear.weight` |
| `embedder-mfn` | `conv1.conv.weight`, `blocks.0.conv.0.weight`, `blocks.14.conv.7.running_var`, `linear7.conv.weight`, `linear1.bn.bias` |
| `embedder-irn50` | `Convolution1.weight`, `BatchNorm1.running_var`, `conv2_res1_proj.weight`, `conv4_res2_conv1_proj.weight`, `fc1_1.weight`, `bn_fc1.weight` |

For `embedder-irn50` the upstream npy dict (`{layer: {'weights','bias','mean',
'var','scale'}}`) maps to state_dict keys through upstream's own loader
(`irn50_pytorch.py` `__conv`/`__batch_normalization`/`__dense`):
`weights → <layer>.weight`, conv/dense `bias → <layer>.bias`, bn
`scale → <layer>.weight`, bn `bias → <layer>.bias`, `mean → <layer>.running_mean`,
`var → <layer>.running_var`; a bn without `scale`/`bias` gets 1/0.

## Model manifest schema (`models/<name>.manifest.json`)

```jsonc
{
  "name": "detector-slim320",          // file stem
  "file": "detector-slim320.safetensors",
  "source_url": "...",                  // exact download URL (null for --irn50)
  "source_sha256": "...",               // pin of the ORIGINAL .pth/.ckpt/.npy
  "license": "...",                     // provenance + license notes (ADR-0003)
  "input": {
    "width": 320, "height": 240, "channels": 3,
    "colorspace": "rgb" | "bgr",        // channel order the net was trained on
    "mean": [127.0, 127.0, 127.0],      // per-channel, subtracted first
    "scale": 0.0078125,                 // multiplied after mean subtraction
    "layout": "nchw",
    "note": "stage-specific cropping/quirks"
  },
  "output": "human-readable output contract",
  "arch": { ... },                      // exact hyperparameters, see below
  "tensors": { "<key>": {"shape": [..], "dtype": "float32"}, ... } // state_dict order
}
```

`arch` always has `family`; spatial sizes anywhere in a manifest are
`[height, width]` (NCHW order), except the explicit `width`/`height` fields.

- detector: `family: "ultraface-ssd"`, `variant: "slim320"`, `num_classes`,
  `num_priors`, `base_channel`, `feature_maps`, `min_boxes`,
  `center_variance`, `size_variance`, `source_layer_indexes`.
- MobileFaceNet variants: `family: "mobilefacenet"`, `style`
  (`"depthwise-residual"` = insightface/cunjian flavor, `"bottleneck"` =
  paper/Xiaoccer flavor), `in_channels`, `input_size`, `activation`
  (`relu`|`prelu`), `gdc_kernel`, `gdc_linear_bias`, `embedding_size`,
  `output_dim`, plus flavor-specific dims (`channels`/`groups`/
  `residual_num_blocks` or `bottleneck_setting`).
- IRN-50: `family: "irn50"`, `input_size`, `bn_eps`, `fc_dim`, `output_dim`,
  `maxout: true`.

## Fixture manifest schema (`tools/fixtures/<name>.json`)

```jsonc
{
  "fixture": "detector-rand",
  "net": "which reference module + constructor args, eval mode",
  "weights": "detector-rand.safetensors"       // fixture-local file, or
           | "real:models/detector-slim320.safetensors", // repo-relative
  "seed": 1234,                       // weight seed (null for real weights)
  "weight_recipe": "randn-kaiming-v1",
  "input_seed": 3407,
  "input_domain": "(randint(0,256) - 127) / 128",
  "input_file": "detector-rand.npz#input",     // npz member after '#'
  "output_files": ["detector-rand.npz#confidences", ...],
  "shapes": { "input": [1,3,240,320], ... },
  "dtype": "float32",
  "tolerance": 1e-4,                  // ABSOLUTE, already scaled (see rule)
  "tolerance_rule": "max|delta| <= 1e-4 * max(1, max|output|), absolute"
}
```

`fixtures/INDEX.json` lists every fixture with its manifest/data/weight files.

## Deterministic inputs

`common.pseudo_image(seed, shape, domain)`: integer pixels drawn uniformly
from `[0, 256)` with a `torch.Generator(seed)`, then the stage's exact
normalization is applied (`(x-127)/128` detector, `x/255` cunjian landmarks,
`x/256` IRN-50 — the upstream quirk, `(x-127.5)/128` Xiaoccer embedder). The
manifest records seed and formula.

## Random-weight recipe `randn-kaiming-v1`

Implemented in `common.fill_random_state(module, seed)`. One
`torch.Generator(seed)`; iterate `module.state_dict()` in key order; per
tensor:

| tensor | fill |
|---|---|
| non-float, or key ends `num_batches_tracked` | untouched (stays 0) |
| key ends `running_var` | `abs(randn) * 0.02 + 1.0` |
| `dim >= 2` (conv/linear weight) | `randn * sqrt(2 / fan_in)`, `fan_in = numel / shape[0]` |
| `dim <= 1`, key ends `.weight` (BN gain, PReLU slope) | `abs(randn) * 0.02 + 1.0` |
| everything else (bias, `running_mean`) | `randn * 0.02` |

Why not the plainer "everything = `randn * 0.02`": with BatchNorm gains of
~0.02 each BN attenuates activations ~50x, and on these depths the recorded
outputs become **bit-identical for different inputs** (measured
`max|Δoutput| == 0.0` on the slim-320 detector) — such fixtures cannot catch
input-path bugs (transposed HW, wrong stride, ...). `randn-kaiming-v1` keeps
unit-scale activations, so outputs genuinely depend on every layer *and* the
input, while remaining fully deterministic from the seed.

The recipe only matters for **regenerating** fixtures; Rust parity tests load
the exact saved `.safetensors`, never re-derive weights.
