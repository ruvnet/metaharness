//! Ported in task #2 — see docs/adrs/0004.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)] pub struct BBox { pub x1: f32, pub y1: f32, pub x2: f32, pub y2: f32 } #[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)] pub struct Detection { pub bbox: BBox, pub score: f32 }
