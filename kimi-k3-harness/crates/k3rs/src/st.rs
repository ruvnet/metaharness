//! Safetensors reader: 8-byte little-endian header length, JSON header with
//! {name: {dtype, shape, data_offsets:[begin,end]}}, then the data blob.
//! The whole file is held in memory; this engine's job is conformance, not the
//! 1.56 TB streaming path (which lives in the C engine's k3_trunk.c).

use crate::json::parse;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dt {
    F32,
    Bf16,
    U8,
}

#[derive(Debug, Clone)]
pub struct TensorInfo {
    pub dtype: Dt,
    pub shape: Vec<usize>,
    pub begin: usize,
    pub end: usize,
}

impl TensorInfo {
    pub fn numel(&self) -> usize {
        self.shape.iter().product()
    }
}

pub struct St {
    pub tensors: HashMap<String, TensorInfo>,
    pub data: Vec<u8>, // the byte buffer AFTER the header
}

impl St {
    pub fn open(path: &std::path::Path) -> Result<St, String> {
        let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if raw.len() < 8 {
            return Err("safetensors: truncated header length".into());
        }
        let hlen = u64::from_le_bytes(raw[..8].try_into().unwrap()) as usize;
        if raw.len() < 8 + hlen {
            return Err("safetensors: truncated header".into());
        }
        let header = std::str::from_utf8(&raw[8..8 + hlen])
            .map_err(|_| "safetensors: header is not UTF-8")?;
        let j = parse(header)?;
        let obj = j.as_obj().ok_or("safetensors: header is not an object")?;
        let mut tensors = HashMap::new();
        for (name, v) in obj {
            if name == "__metadata__" {
                continue;
            }
            let dtype = match v.get("dtype").and_then(|d| d.as_str()) {
                Some("F32") => Dt::F32,
                Some("BF16") => Dt::Bf16,
                Some("U8") => Dt::U8,
                Some(other) => return Err(format!("{name}: unsupported dtype {other}")),
                None => return Err(format!("{name}: missing dtype")),
            };
            let shape = v
                .get("shape")
                .and_then(|s| s.as_arr())
                .ok_or_else(|| format!("{name}: missing shape"))?
                .iter()
                .map(|x| x.as_i().unwrap_or(0) as usize)
                .collect();
            let offs = v
                .get("data_offsets")
                .and_then(|s| s.as_arr())
                .ok_or_else(|| format!("{name}: missing data_offsets"))?;
            let begin = offs[0].as_i().unwrap_or(0) as usize;
            let end = offs[1].as_i().unwrap_or(0) as usize;
            tensors.insert(name.clone(), TensorInfo { dtype, shape, begin, end });
        }
        Ok(St { tensors, data: raw[8 + hlen..].to_vec() })
    }

    pub fn find(&self, name: &str) -> Option<&TensorInfo> {
        self.tensors.get(name)
    }

    pub fn bytes(&self, t: &TensorInfo) -> &[u8] {
        &self.data[t.begin..t.end]
    }

    /// Read as f32, widening bf16 exactly (a pure 16-bit left shift).
    pub fn read_f32(&self, t: &TensorInfo) -> Result<Vec<f32>, String> {
        let b = self.bytes(t);
        match t.dtype {
            Dt::F32 => Ok(b
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
                .collect()),
            Dt::Bf16 => Ok(b
                .chunks_exact(2)
                .map(|c| bf16f(u16::from_le_bytes(c.try_into().unwrap())))
                .collect()),
            Dt::U8 => Err("read_f32 on a U8 tensor".into()),
        }
    }

    /// Read raw bf16 element stream.
    pub fn read_bf16(&self, t: &TensorInfo) -> Result<Vec<u16>, String> {
        match t.dtype {
            Dt::Bf16 => Ok(self
                .bytes(t)
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
                .collect()),
            _ => Err("read_bf16 on a non-BF16 tensor".into()),
        }
    }
}

/// bf16 -> f32 is a pure left shift: bf16 IS the top 16 bits of an f32.
#[inline(always)]
pub fn bf16f(h: u16) -> f32 {
    f32::from_bits((h as u32) << 16)
}
