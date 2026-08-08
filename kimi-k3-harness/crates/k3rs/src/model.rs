//! Config, weight binding (HF dotted names), the layer stack, and greedy decode —
//! the Rust equivalent of k3_cfg.h + k3_bind.c + the layer/model code in k3_ops.c
//! and the forward loop in k3_run.c (full-recompute path, the one the oracle
//! validates).

use crate::json::{parse, J};
use crate::ops::*;
use crate::st::{Dt, St};

pub const MXFP4_GROUP: usize = 32;
const PRE: &str = "language_model.model.";

#[derive(Debug, Clone)]
pub struct Cfg {
    pub hidden: usize,
    pub n_layers: usize,
    pub vocab: usize,
    pub rms_eps: f32,
    pub kda_heads: usize,
    pub kda_head_dim: usize,
    pub conv_k: usize,
    pub gate_lb: f32,
    pub n_heads: usize,
    pub q_lora: usize,
    pub kv_lora: usize,
    pub qk_nope: usize,
    pub qk_rope: usize,
    pub v_head: usize,
    pub mla_out_gate: bool,
    pub n_experts: usize,
    pub topk: usize,
    pub n_shared: usize,
    pub latent: usize,
    pub moe_inter: usize,
    pub routed_scale: f32,
    pub moe_renorm: bool,
    pub latent_norm: bool,
    pub first_dense: usize,
    pub dense_inter: usize,
    pub attn_res_block: usize,
    pub situ_b1: f32,
    pub situ_b2: f32,
    pub full_attn: Vec<usize>, // ONE-based layer indices
}

impl Cfg {
    pub fn is_mla(&self, layer: usize) -> bool {
        self.full_attn.contains(&(layer + 1))
    }
    pub fn is_dense(&self, layer: usize) -> bool {
        layer < self.first_dense
    }

    pub fn load(dir: &std::path::Path) -> Result<Cfg, String> {
        let raw = std::fs::read_to_string(dir.join("config.json"))
            .map_err(|e| format!("config.json: {e}"))?;
        let root = parse(&raw)?;
        // The released config nests under text_config / linear_attn_config; the
        // fixture (and tiny) spelling is flat. Search lin, then base, per alias.
        let base = root.get("text_config").unwrap_or(&root);
        let lin = base.get("linear_attn_config");
        let find = |primary: &str, alias: Option<&str>| -> Option<J> {
            for name in std::iter::once(primary).chain(alias) {
                if let Some(l) = lin {
                    if let Some(v) = l.get(name) {
                        return Some(v.clone());
                    }
                }
                if let Some(v) = base.get(name) {
                    return Some(v.clone());
                }
                if let Some(v) = root.get(name) {
                    return Some(v.clone());
                }
            }
            None
        };
        let gi = |p: &str, a: Option<&str>| -> Result<usize, String> {
            find(p, a).and_then(|v| v.as_i()).map(|x| x as usize).ok_or(format!("config: missing {p}"))
        };
        let gf = |p: &str, a: Option<&str>| -> Result<f32, String> {
            find(p, a).and_then(|v| v.as_f()).map(|x| x as f32).ok_or(format!("config: missing {p}"))
        };
        let gb = |p: &str, dflt: bool| -> bool {
            find(p, None).and_then(|v| v.as_bool()).unwrap_or(dflt)
        };
        let fal = find("full_attn_layers", None)
            .and_then(|v| v.as_arr().map(|a| a.iter().filter_map(|x| x.as_i()).map(|x| x as usize).collect::<Vec<_>>()))
            .ok_or("config: missing full_attn_layers")?;
        Ok(Cfg {
            hidden: gi("hidden_size", None)?,
            n_layers: gi("num_hidden_layers", None)?,
            vocab: gi("vocab_size", None)?,
            rms_eps: gf("rms_norm_eps", None)?,
            kda_heads: gi("num_heads", Some("kda_num_heads"))?,
            kda_head_dim: gi("head_dim", Some("kda_head_dim"))?,
            conv_k: gi("short_conv_kernel_size", None)?,
            gate_lb: gf("gate_lower_bound", None)?,
            n_heads: gi("num_attention_heads", None)?,
            q_lora: gi("q_lora_rank", None)?,
            kv_lora: gi("kv_lora_rank", None)?,
            qk_nope: gi("qk_nope_head_dim", None)?,
            qk_rope: gi("qk_rope_head_dim", None)?,
            v_head: gi("v_head_dim", None)?,
            mla_out_gate: gb("mla_use_output_gate", true),
            n_experts: gi("num_experts", None)?,
            topk: gi("num_experts_per_token", None)?,
            n_shared: gi("num_shared_experts", None)?,
            latent: gi("routed_expert_hidden_size", None)?,
            moe_inter: gi("moe_intermediate_size", None)?,
            routed_scale: gf("routed_scaling_factor", None)?,
            moe_renorm: gb("moe_renormalize", true),
            latent_norm: gb("latent_moe_use_norm", true),
            first_dense: gi("first_k_dense_replace", None)?,
            dense_inter: gi("intermediate_size", None)?,
            attn_res_block: gi("attn_res_block_size", None)?,
            situ_b1: gf("activation_situ_beta", Some("situ_beta"))?,
            situ_b2: gf("activation_situ_linear_beta", Some("situ_linear_beta"))?,
            full_attn: fal,
        })
    }
}

// ------------------------------------------------------------ weight structs

pub struct KdaW {
    pub q: Mat,
    pub k: Mat,
    pub v: Mat,
    pub g: Mat,
    pub o: Mat,
    pub q_conv: Vec<f32>,
    pub k_conv: Vec<f32>,
    pub v_conv: Vec<f32>,
    pub f_a: Mat,
    pub f_b: Mat,
    pub b: Mat,
    pub a_log: Vec<f32>, // first kda_heads entries only (PER HEAD)
    pub dt_bias: Vec<f32>,
    pub o_norm: Vec<f32>,
}

pub struct MlaW {
    pub q_a: Mat,
    pub q_b: Mat,
    pub kv_a: Mat,
    pub kv_b: Mat,
    pub o: Mat,
    pub g: Option<Mat>,
    pub q_a_norm: Vec<f32>,
    pub kv_a_norm: Vec<f32>,
}

pub struct Expert {
    pub p1: Vec<u8>,
    pub s1: Vec<u8>,
    pub p3: Vec<u8>,
    pub s3: Vec<u8>,
    pub p2: Vec<u8>,
    pub s2: Vec<u8>,
}

pub struct MoeW {
    pub gate: Vec<f32>, // fp32 on purpose: the router walks it elementwise
    pub bias: Vec<f32>,
    pub down: Mat,
    pub up: Mat,
    pub latent_norm: Vec<f32>,
    pub sh1: Mat,
    pub sh3: Mat,
    pub sh2: Mat,
    pub experts: Vec<Expert>,
}

pub struct LayerW {
    pub in_norm: Vec<f32>,
    pub post_norm: Vec<f32>,
    pub fold_attn: Vec<f32>, // attn_res_norm * attn_res_proj, folded at load
    pub fold_mlp: Vec<f32>,
    pub kda: Option<KdaW>,
    pub mla: Option<MlaW>,
    pub moe: Option<MoeW>,
    pub dense: Option<(Mat, Mat, Mat)>, // gate, up, down
}

pub struct Model {
    pub cfg: Cfg,
    pub layers: Vec<LayerW>,
    pub embed: Mat,
    pub norm: Vec<f32>,
    pub out_fold: Vec<f32>, // out_res_norm * out_res_proj
    pub lm_head: Mat,
}

// ------------------------------------------------------------------- binding

fn wide(st: &St, name: &str, want: usize, take: usize) -> Result<Vec<f32>, String> {
    let t = st.find(name).ok_or(format!("missing tensor {name}"))?;
    let have = t.numel();
    if want != 0 && have != want {
        return Err(format!("{name}: has {have} elements, engine expects {want}"));
    }
    let mut v = st.read_f32(t)?;
    if take != 0 && take < v.len() {
        v.truncate(take); // A_log: PER HEAD prefix of the shipped head_dim floats
    }
    Ok(v)
}

fn narrow(st: &St, name: &str, want: usize) -> Result<Mat, String> {
    let t = st.find(name).ok_or(format!("missing tensor {name}"))?;
    let have = t.numel();
    if want != 0 && have != want {
        return Err(format!("{name}: has {have} elements, engine expects {want}"));
    }
    // Keep the checkpoint's own bf16 bytes; anything else is widened. (Mat carries
    // its own tag per tensor, so no whole-layer demotion dance is needed here.)
    match t.dtype {
        Dt::Bf16 => Ok(Mat::Bf16(st.read_bf16(t)?)),
        _ => Ok(Mat::F32(st.read_f32(t)?)),
    }
}

fn raw_u8(st: &St, name: &str) -> Result<Vec<u8>, String> {
    let t = st.find(name).ok_or(format!("missing tensor {name}"))?;
    Ok(st.bytes(t).to_vec())
}

impl Model {
    pub fn load(dir: &std::path::Path) -> Result<Model, String> {
        let cfg = Cfg::load(dir)?;
        let st = St::open(&dir.join("model.safetensors"))?;
        let c = &cfg;
        let h = c.hidden;
        let p = c.kda_heads * c.kda_head_dim;

        let mut layers = Vec::with_capacity(c.n_layers);
        for l in 0..c.n_layers {
            let n = |suffix: &str| format!("{PRE}layers.{l}.{suffix}");
            let fold = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).collect::<Vec<f32>>();
            let arn = wide(&st, &n("self_attention_res_norm.weight"), h, 0)?;
            let arp = wide(&st, &n("self_attention_res_proj.weight"), h, 0)?;
            let mrn = wide(&st, &n("mlp_res_norm.weight"), h, 0)?;
            let mrp = wide(&st, &n("mlp_res_proj.weight"), h, 0)?;

            let (kda, mla) = if c.is_mla(l) {
                let qh = c.qk_nope + c.qk_rope;
                (
                    None,
                    Some(MlaW {
                        q_a: narrow(&st, &n("self_attn.q_a_proj.weight"), c.q_lora * h)?,
                        q_a_norm: wide(&st, &n("self_attn.q_a_layernorm.weight"), c.q_lora, 0)?,
                        q_b: narrow(&st, &n("self_attn.q_b_proj.weight"), c.n_heads * qh * c.q_lora)?,
                        kv_a: narrow(&st, &n("self_attn.kv_a_proj_with_mqa.weight"), (c.kv_lora + c.qk_rope) * h)?,
                        kv_a_norm: wide(&st, &n("self_attn.kv_a_layernorm.weight"), c.kv_lora, 0)?,
                        kv_b: narrow(&st, &n("self_attn.kv_b_proj.weight"), c.n_heads * (c.qk_nope + c.v_head) * c.kv_lora)?,
                        o: narrow(&st, &n("self_attn.o_proj.weight"), h * c.n_heads * c.v_head)?,
                        g: if c.mla_out_gate {
                            Some(narrow(&st, &n("self_attn.g_proj.weight"), c.n_heads * c.v_head * h)?)
                        } else {
                            None
                        },
                    }),
                )
            } else {
                (
                    Some(KdaW {
                        q: narrow(&st, &n("self_attn.q_proj.weight"), p * h)?,
                        k: narrow(&st, &n("self_attn.k_proj.weight"), p * h)?,
                        v: narrow(&st, &n("self_attn.v_proj.weight"), p * h)?,
                        g: narrow(&st, &n("self_attn.g_proj.weight"), p * h)?,
                        o: narrow(&st, &n("self_attn.o_proj.weight"), h * p)?,
                        q_conv: wide(&st, &n("self_attn.q_conv1d.weight"), p * c.conv_k, 0)?,
                        k_conv: wide(&st, &n("self_attn.k_conv1d.weight"), p * c.conv_k, 0)?,
                        v_conv: wide(&st, &n("self_attn.v_conv1d.weight"), p * c.conv_k, 0)?,
                        f_a: narrow(&st, &n("self_attn.f_a_proj.weight"), c.kda_head_dim * h)?,
                        f_b: narrow(&st, &n("self_attn.f_b_proj.weight"), p * c.kda_head_dim)?,
                        b: narrow(&st, &n("self_attn.b_proj.weight"), c.kda_heads * h)?,
                        a_log: wide(&st, &n("self_attn.A_log"), c.kda_head_dim, c.kda_heads)?,
                        dt_bias: wide(&st, &n("self_attn.dt_bias"), p, 0)?,
                        o_norm: wide(&st, &n("self_attn.o_norm.weight"), c.kda_head_dim, 0)?,
                    }),
                    None,
                )
            };

            let (moe, dense) = if c.is_dense(l) {
                (
                    None,
                    Some((
                        narrow(&st, &n("mlp.gate_proj.weight"), c.dense_inter * h)?,
                        narrow(&st, &n("mlp.up_proj.weight"), c.dense_inter * h)?,
                        narrow(&st, &n("mlp.down_proj.weight"), h * c.dense_inter)?,
                    )),
                )
            } else {
                let si = c.moe_inter * c.n_shared;
                let mut experts = Vec::with_capacity(c.n_experts);
                for e in 0..c.n_experts {
                    let en = |m: &str, part: &str| {
                        format!("{PRE}layers.{l}.block_sparse_moe.experts.{e}.{m}.weight_{part}")
                    };
                    experts.push(Expert {
                        p1: raw_u8(&st, &en("w1", "packed"))?,
                        s1: raw_u8(&st, &en("w1", "scale"))?,
                        p3: raw_u8(&st, &en("w3", "packed"))?,
                        s3: raw_u8(&st, &en("w3", "scale"))?,
                        p2: raw_u8(&st, &en("w2", "packed"))?,
                        s2: raw_u8(&st, &en("w2", "scale"))?,
                    });
                }
                (
                    Some(MoeW {
                        gate: wide(&st, &n("block_sparse_moe.gate.weight"), c.n_experts * h, 0)?,
                        bias: wide(&st, &n("block_sparse_moe.gate.e_score_correction_bias"), c.n_experts, 0)?,
                        down: narrow(&st, &n("block_sparse_moe.routed_expert_down_proj.weight"), c.latent * h)?,
                        up: narrow(&st, &n("block_sparse_moe.routed_expert_up_proj.weight"), h * c.latent)?,
                        latent_norm: wide(&st, &n("block_sparse_moe.routed_expert_norm.weight"), c.latent, 0)?,
                        sh1: narrow(&st, &n("block_sparse_moe.shared_experts.gate_proj.weight"), si * h)?,
                        sh3: narrow(&st, &n("block_sparse_moe.shared_experts.up_proj.weight"), si * h)?,
                        sh2: narrow(&st, &n("block_sparse_moe.shared_experts.down_proj.weight"), h * si)?,
                        experts,
                    }),
                    None,
                )
            };

            layers.push(LayerW {
                in_norm: wide(&st, &n("input_layernorm.weight"), h, 0)?,
                post_norm: wide(&st, &n("post_attention_layernorm.weight"), h, 0)?,
                fold_attn: fold(&arn, &arp),
                fold_mlp: fold(&mrn, &mrp),
                kda,
                mla,
                moe,
                dense,
            });
        }

        let orn = wide(&st, &format!("{PRE}output_attn_res_norm.weight"), h, 0)?;
        let orp = wide(&st, &format!("{PRE}output_attn_res_proj.weight"), h, 0)?;
        Ok(Model {
            embed: narrow(&st, &format!("{PRE}embed_tokens.weight"), cfg.vocab * h)?,
            norm: wide(&st, &format!("{PRE}norm.weight"), h, 0)?,
            out_fold: orn.iter().zip(&orp).map(|(a, b)| a * b).collect(),
            lm_head: narrow(&st, "language_model.lm_head.weight", cfg.vocab * h)?,
            cfg,
            layers,
        })
    }
}

// -------------------------------------------------------------- layer kernels

/// Gated MLA, NoPE, full sequence, no cache — k3_mla with kvc == NULL.
fn mla_layer(out: &mut [f32], x: &[f32], w: &MlaW, c: &Cfg, t_len: usize) {
    let e = c.hidden;
    let hn = c.n_heads;
    let (qn, qr, vh) = (c.qk_nope, c.qk_rope, c.v_head);
    let qh = qn + qr;
    let kvw = c.kv_lora + qr;
    let kvd = qn + vh;
    let scale = 1.0 / (qh as f32).sqrt();

    let mut q = vec![0.0f32; t_len * hn * qh];
    let mut kvs = vec![0.0f32; t_len * hn * kvd];
    let mut rps = vec![0.0f32; t_len * qr];
    let mut ct = vec![0.0f32; kvw];
    let mut ql = vec![0.0f32; c.q_lora];
    let mut acc = vec![0.0f32; hn * vh];
    let mut gbuf = vec![0.0f32; hn * vh];
    let mut sc = vec![0.0f32; t_len];

    for t in 0..t_len {
        let xt = &x[t * e..(t + 1) * e];
        matmul(&mut ql, xt, &w.q_a, e, c.q_lora);
        rmsnorm_inplace(&mut ql, &w.q_a_norm, c.q_lora, c.rms_eps);
        matmul(&mut q[t * hn * qh..(t + 1) * hn * qh], &ql, &w.q_b, c.q_lora, hn * qh);
        matmul(&mut ct, xt, &w.kv_a, e, kvw);
        // the norm covers the latent only, never the rope slot
        {
            let (latent, rope) = ct.split_at_mut(c.kv_lora);
            rmsnorm_inplace(latent, &w.kv_a_norm, c.kv_lora, c.rms_eps);
            rps[t * qr..(t + 1) * qr].copy_from_slice(&rope[..qr]);
        }
        matmul(&mut kvs[t * hn * kvd..(t + 1) * hn * kvd], &ct[..c.kv_lora], &w.kv_b, c.kv_lora, hn * kvd);
    }

    for t in 0..t_len {
        for hh in 0..hn {
            let qt = &q[(t * hn + hh) * qh..(t * hn + hh + 1) * qh];
            let mut m = f32::NEG_INFINITY;
            for s in 0..=t {
                let ks = &kvs[(s * hn + hh) * kvd..];
                let kr = &rps[s * qr..];
                let mut d = 0.0f64;
                for i in 0..qn {
                    d += qt[i] as f64 * ks[i] as f64;
                }
                // the UNROTATED rope slot is still scored, shared across heads
                for i in 0..qr {
                    d += qt[qn + i] as f64 * kr[i] as f64;
                }
                sc[s] = d as f32 * scale;
                if sc[s] > m {
                    m = sc[s];
                }
            }
            let mut z = 0.0f64;
            for s in 0..=t {
                sc[s] = (sc[s] - m).exp();
                z += sc[s] as f64;
            }
            let o = &mut acc[hh * vh..(hh + 1) * vh];
            o.iter_mut().for_each(|v| *v = 0.0);
            for s in 0..=t {
                let pr = (sc[s] as f64 / z) as f32;
                let vs = &kvs[(s * hn + hh) * kvd + qn..];
                for j in 0..vh {
                    o[j] += pr * vs[j];
                }
            }
        }
        // gate BEFORE o_proj, no norm — the opposite order to KDA
        if let Some(g) = &w.g {
            matmul(&mut gbuf, &x[t * e..(t + 1) * e], g, e, hn * vh);
            for i in 0..hn * vh {
                acc[i] *= 1.0 / (1.0 + (-gbuf[i]).exp());
            }
        }
        matmul(&mut out[t * e..(t + 1) * e], &acc, &w.o, hn * vh, e);
    }
}

/// Kimi Delta Attention, one full layer, one sequence — k3_kda_layer.
fn kda_layer(out: &mut [f32], x: &[f32], w: &KdaW, c: &Cfg, t_len: usize) {
    let e = c.hidden;
    let hn = c.kda_heads;
    let d = c.kda_head_dim;
    let p = hn * d;
    let k_k = c.conv_k;

    let mut q = vec![0.0f32; t_len * p];
    let mut k = vec![0.0f32; t_len * p];
    let mut v = vec![0.0f32; t_len * p];
    let mut z = vec![0.0f32; t_len * p];
    let mut al = vec![0.0f32; t_len * p];
    let mut bt = vec![0.0f32; t_len * hn];
    let mut o = vec![0.0f32; t_len * p];
    let mut gb = vec![0.0f32; p];
    let mut fa = vec![0.0f32; d];

    // 1. projections; ONE shared low-rank pair feeds every head
    for t in 0..t_len {
        let xt = &x[t * e..(t + 1) * e];
        matmul(&mut q[t * p..(t + 1) * p], xt, &w.q, e, p);
        matmul(&mut k[t * p..(t + 1) * p], xt, &w.k, e, p);
        matmul(&mut v[t * p..(t + 1) * p], xt, &w.v, e, p);
        matmul(&mut bt[t * hn..(t + 1) * hn], xt, &w.b, e, hn);
        matmul(&mut fa, xt, &w.f_a, e, d);
        matmul(&mut z[t * p..(t + 1) * p], &fa, &w.f_b, d, p);
    }

    // 2. ShortConv with fused SiLU (fresh sequence: zero history)
    shortconv(&mut q, &w.q_conv, None, p, k_k, t_len);
    shortconv(&mut k, &w.k_conv, None, p, k_k, t_len);
    shortconv(&mut v, &w.v_conv, None, p, k_k, t_len);

    // 3. L2Norm on q and k ONLY, per head
    for t in 0..t_len {
        for hh in 0..hn {
            l2norm(&mut q[t * p + hh * d..t * p + (hh + 1) * d], 1e-6);
            l2norm(&mut k[t * p + hh * d..t * p + (hh + 1) * d], 1e-6);
        }
    }

    // 4/5. beta and the decay chain (the C caller writes g back over z in place)
    for t in 0..t_len {
        for hh in 0..hn {
            bt[t * hn + hh] = sigmoidf(bt[t * hn + hh]);
        }
        let zin = z[t * p..(t + 1) * p].to_vec();
        kda_decay(
            &mut z[t * p..(t + 1) * p],
            &mut al[t * p..(t + 1) * p],
            &zin,
            &w.a_log,
            &w.dt_bias,
            hn,
            d,
            c.gate_lb,
        );
    }

    // 6. recurrence, per head, q pre-scaled by d_k^-0.5. Heads are independent
    // (each reads/writes only its own S block and D-wide slices; the recurrence
    // is sequential in t WITHIN a head), so the head loop threads with
    // bit-identical results — the same contract as the C engine's OpenMP loop.
    // Threaded heads write compact private [T][D] buffers (o's per-head columns
    // are strided) and scatter after the join; the scatter is a pure copy.
    let qscale = 1.0 / (d as f32).sqrt();
    let mut s_state = vec![0.0f32; hn * d * d];
    let nt = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    if hn >= 8 && nt >= 2 {
        let mut o_priv = vec![0.0f32; hn * t_len * d];
        {
            let (q, k, v, al, bt) = (&q, &k, &v, &al, &bt);
            std::thread::scope(|sc| {
                for (hh, (s_h, o_h)) in s_state
                    .chunks_mut(d * d)
                    .zip(o_priv.chunks_mut(t_len * d))
                    .enumerate()
                {
                    sc.spawn(move || {
                        let mut wh = vec![0.0f32; d];
                        let mut u = vec![0.0f32; d];
                        for t in 0..t_len {
                            let off = t * p + hh * d;
                            for i in 0..d {
                                wh[i] = q[off + i] * qscale;
                            }
                            kda_step_scratch(
                                s_h,
                                &mut o_h[t * d..(t + 1) * d],
                                &wh,
                                &k[off..off + d],
                                &v[off..off + d],
                                &al[off..off + d],
                                bt[t * hn + hh],
                                d,
                                d,
                                &mut u,
                            );
                        }
                    });
                }
            });
        }
        for hh in 0..hn {
            for t in 0..t_len {
                o[t * p + hh * d..t * p + (hh + 1) * d]
                    .copy_from_slice(&o_priv[hh * t_len * d + t * d..hh * t_len * d + (t + 1) * d]);
            }
        }
    } else {
        let mut wh = vec![0.0f32; d];
        let mut u = vec![0.0f32; d];
        for hh in 0..hn {
            for t in 0..t_len {
                let off = t * p + hh * d;
                for i in 0..d {
                    wh[i] = q[off + i] * qscale;
                }
                kda_step_scratch(
                    &mut s_state[hh * d * d..(hh + 1) * d * d],
                    &mut o[off..off + d],
                    &wh,
                    &k[off..off + d],
                    &v[off..off + d],
                    &al[off..off + d],
                    bt[t * hn + hh],
                    d,
                    d,
                    &mut u,
                );
            }
        }
    }

    // 7/8/9. head-wise RMSNorm, THEN the gate, THEN the output projection
    for t in 0..t_len {
        let xt = &x[t * e..(t + 1) * e];
        for hh in 0..hn {
            rmsnorm_inplace(&mut o[t * p + hh * d..t * p + (hh + 1) * d], &w.o_norm, d, c.rms_eps);
        }
        matmul(&mut gb, xt, &w.g, e, p);
        for i in 0..p {
            o[t * p + i] *= sigmoidf(gb[i]);
        }
        matmul(&mut out[t * e..(t + 1) * e], &o[t * p..(t + 1) * p], &w.o, p, e);
    }
}

/// Stable LatentMoE, per token — k3_moe with a streamed-MXFP4-equivalent source.
fn moe_layer(out: &mut [f32], x: &[f32], w: &MoeW, c: &Cfg, t_len: usize) {
    let e = c.hidden;
    let ll = c.latent;
    let ii = c.moe_inter;
    let si = ii * c.n_shared;

    let mut idx = vec![0usize; c.topk];
    let mut wt = vec![0.0f32; c.topk];
    let mut z = vec![0.0f32; ll];
    let mut acc_l = vec![0.0f32; ll];
    let mut gu = vec![0.0f32; 2 * ii];
    let mut act = vec![0.0f32; ii];
    let mut edn = vec![0.0f32; ll];
    let mut sgu = vec![0.0f32; 2 * si];
    let mut sact = vec![0.0f32; si];
    let mut sdn = vec![0.0f32; e];

    for t in 0..t_len {
        let xt = &x[t * e..(t + 1) * e];
        let ot = &mut out[t * e..(t + 1) * e];

        // 1. route on the FULL width, before the down-projection
        router(&mut idx, &mut wt, xt, &w.gate, &w.bias, e, c.n_experts, c.topk, c.moe_renorm, c.routed_scale);

        // 2. down-project into the latent space
        matmul(&mut z, xt, &w.down, e, ll);

        // 3. the selected experts, in latent space, weighted and summed
        acc_l.iter_mut().for_each(|v| *v = 0.0);
        for j in 0..c.topk {
            let ex = &w.experts[idx[j]];
            let (g_half, u_half) = gu.split_at_mut(ii);
            matmul_mxfp4(g_half, &z, &ex.p1, &ex.s1, ll, ii, MXFP4_GROUP);
            matmul_mxfp4(u_half, &z, &ex.p3, &ex.s3, ll, ii, MXFP4_GROUP);
            situ_glu(&mut act, &gu, ii, c.situ_b1, c.situ_b2);
            matmul_mxfp4(&mut edn, &act, &ex.p2, &ex.s2, ii, ll, MXFP4_GROUP);
            let wj = wt[j];
            for i in 0..ll {
                acc_l[i] += wj * edn[i];
            }
        }

        // 4. RMSNorm the AGGREGATE (not per expert), then 5. up-project
        if c.latent_norm {
            rmsnorm_inplace(&mut acc_l, &w.latent_norm, ll, c.rms_eps);
        }
        matmul(ot, &acc_l, &w.up, ll, e);

        // 6. shared expert on the ORIGINAL input, added UNWEIGHTED
        {
            let (sg, su) = sgu.split_at_mut(si);
            matmul(sg, xt, &w.sh1, e, si);
            matmul(su, xt, &w.sh3, e, si);
        }
        situ_glu(&mut sact, &sgu, si, c.situ_b1, c.situ_b2);
        matmul(&mut sdn, &sact, &w.sh2, si, e);
        for i in 0..e {
            ot[i] += sdn[i];
        }
    }
}

/// One decoder layer — k3_decoder_layer, reproducing _forward_attn_residual
/// statement for statement (including the boundary snapshot-then-CLEAR).
fn decoder_layer(
    h: &mut [f32],
    br: &mut [f32],
    n_blocks: &mut usize,
    w: &LayerW,
    c: &Cfg,
    layer_idx: usize,
    t_len: usize,
) {
    let e = c.hidden;
    let maxb = c.n_layers / c.attn_res_block + 2;

    let mut pref = h.to_vec();
    let mut tmp = vec![0.0f32; t_len * e];
    let mut hin = vec![0.0f32; t_len * e];
    let mut src = vec![0.0f32; (maxb + 1) * e];
    let mut have_prefix = true;

    // aggregation before attention, only when snapshots already exist
    if *n_blocks > 0 {
        for t in 0..t_len {
            for b in 0..*n_blocks {
                src[b * e..(b + 1) * e].copy_from_slice(&br[(t * maxb + b) * e..(t * maxb + b + 1) * e]);
            }
            src[*n_blocks * e..(*n_blocks + 1) * e].copy_from_slice(&pref[t * e..(t + 1) * e]);
            attn_res(&mut h[t * e..(t + 1) * e], &src, &w.fold_attn, *n_blocks + 1, e, c.rms_eps);
        }
    }

    // block boundary: snapshot the running residual, then CLEAR it
    if layer_idx % c.attn_res_block == 0 {
        for t in 0..t_len {
            br[(t * maxb + *n_blocks) * e..(t * maxb + *n_blocks + 1) * e]
                .copy_from_slice(&pref[t * e..(t + 1) * e]);
        }
        *n_blocks += 1;
        have_prefix = false;
    }

    // attention
    for t in 0..t_len {
        let (dst, src_h) = (&mut hin[t * e..(t + 1) * e], &h[t * e..(t + 1) * e]);
        rmsnorm(dst, src_h, &w.in_norm, e, c.rms_eps);
    }
    if let Some(kda) = &w.kda {
        kda_layer(&mut tmp, &hin, kda, c, t_len);
    } else {
        mla_layer(&mut tmp, &hin, w.mla.as_ref().unwrap(), c, t_len);
    }

    if have_prefix {
        for i in 0..t_len * e {
            pref[i] += tmp[i];
        }
    } else {
        pref.copy_from_slice(&tmp);
        // have_prefix becomes true again (mirrors the C flow)
    }

    // aggregation before the MLP. NO emptiness guard in the reference.
    for t in 0..t_len {
        for b in 0..*n_blocks {
            src[b * e..(b + 1) * e].copy_from_slice(&br[(t * maxb + b) * e..(t * maxb + b + 1) * e]);
        }
        src[*n_blocks * e..(*n_blocks + 1) * e].copy_from_slice(&pref[t * e..(t + 1) * e]);
        attn_res(&mut h[t * e..(t + 1) * e], &src, &w.fold_mlp, *n_blocks + 1, e, c.rms_eps);
    }

    for t in 0..t_len {
        let (dst, src_h) = (&mut hin[t * e..(t + 1) * e], &h[t * e..(t + 1) * e]);
        rmsnorm(dst, src_h, &w.post_norm, e, c.rms_eps);
    }

    if let Some(moe) = &w.moe {
        moe_layer(&mut tmp, &hin, moe, c, t_len);
    } else {
        let (dg, du, dd) = w.dense.as_ref().unwrap();
        let di = c.dense_inter;
        let mut dgu = vec![0.0f32; 2 * di];
        let mut dact = vec![0.0f32; di];
        for t in 0..t_len {
            let xt = &hin[t * e..(t + 1) * e];
            {
                let (g_half, u_half) = dgu.split_at_mut(di);
                matmul(g_half, xt, dg, e, di);
                matmul(u_half, xt, du, e, di);
            }
            situ_glu(&mut dact, &dgu, di, c.situ_b1, c.situ_b2);
            matmul(&mut tmp[t * e..(t + 1) * e], &dact, dd, di, e);
        }
    }

    for i in 0..t_len * e {
        pref[i] += tmp[i];
    }
    h.copy_from_slice(&pref);
}

// ------------------------------------------------------------------- forward

impl Model {
    /// One full forward over T tokens (full recompute — the oracle-validated
    /// path). Returns the FINAL position's logits.
    pub fn forward(&self, ids: &[usize]) -> Vec<f32> {
        let c = &self.cfg;
        let e = c.hidden;
        let t_len = ids.len();
        let maxb = c.n_layers / c.attn_res_block + 2;

        let mut h = vec![0.0f32; t_len * e];
        for (t, &id) in ids.iter().enumerate() {
            for i in 0..e {
                h[t * e + i] = self.embed.at(id * e + i);
            }
        }
        let mut br = vec![0.0f32; t_len * maxb * e];
        let mut nb = 0usize;
        for (l, lw) in self.layers.iter().enumerate() {
            decoder_layer(&mut h, &mut br, &mut nb, lw, c, l, t_len);
        }

        // model-level AttnRes aggregator — skipping it is silent
        let mut src = vec![0.0f32; (nb + 1) * e];
        for t in 0..t_len {
            for b in 0..nb {
                src[b * e..(b + 1) * e].copy_from_slice(&br[(t * maxb + b) * e..(t * maxb + b + 1) * e]);
            }
            src[nb * e..(nb + 1) * e].copy_from_slice(&h[t * e..(t + 1) * e]);
            let mut out_t = vec![0.0f32; e];
            attn_res(&mut out_t, &src, &self.out_fold, nb + 1, e, c.rms_eps);
            h[t * e..(t + 1) * e].copy_from_slice(&out_t);
        }

        let mut nrm = vec![0.0f32; e];
        rmsnorm(&mut nrm, &h[(t_len - 1) * e..], &self.norm, e, c.rms_eps);
        let mut logits = vec![0.0f32; c.vocab];
        matmul(&mut logits, &nrm, &self.lm_head, e, c.vocab);
        logits
    }
}

pub fn argmax(v: &[f32]) -> usize {
    let mut best = 0usize;
    for i in 1..v.len() {
        if v[i] > v[best] {
            best = i;
        }
    }
    best
}
