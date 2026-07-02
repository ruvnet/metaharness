//! rvface-wasm: browser bindings. API per docs/adrs/0005.

use wasm_bindgen::prelude::*;

/// Placeholder export so the scaffold builds; replaced by the full
/// `RvFace` binding (new/detect/analyze/similarity) as implementation lands.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
