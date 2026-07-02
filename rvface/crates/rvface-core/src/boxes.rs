//! SSD detector post-processing: prior generation, location decoding, IoU,
//! hard NMS, and the predict-time filtering chain.
//!
//! Exact port of the upstream Python (`face_detect/vision/utils/box_utils.py`,
//! `face_detect/vision/ssd/config/fd_config.py`, `predictor.py`,
//! `detect_imgs.py`); see ADR-0004. Softmax over the two classes is applied
//! by `rvface-models`; this module consumes probabilities.

/// Axis-aligned box in corner form (`x1,y1` top-left, `x2,y2` bottom-right).
///
/// Coordinates are relative (0..1) straight out of [`decode_locations`] /
/// [`center_to_corner`], and pixels after [`postprocess`] scales them.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct BBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

/// A scored face detection.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Detection {
    pub bbox: BBox,
    pub score: f32,
}

/// Box in center form `[cx, cy, w, h]`, the layout of priors and of decoded
/// locations before corner conversion (upstream keeps these as raw tensors).
pub type CenterBox = [f32; 4];

/// Upstream `fd_config.center_variance`.
pub const CENTER_VARIANCE: f32 = 0.1;
/// Upstream `fd_config.size_variance`.
pub const SIZE_VARIANCE: f32 = 0.2;
/// Upstream `fd_config.iou_threshold` (hard-NMS suppression threshold).
pub const IOU_THRESHOLD: f32 = 0.3;
/// Upstream `detect_imgs.threshold` (class-1 probability threshold).
pub const PROB_THRESHOLD: f32 = 0.6;
/// Upstream `detect_imgs.candidate_size`: hard-NMS candidate pool size.
pub const CANDIDATE_SIZE: usize = 1500;
/// Upstream passes `candidate_size / 2` as `top_k` to `Predictor.predict`.
pub const TOP_K: i32 = 750;

/// Upstream `fd_config.min_boxes`: anchor side lengths (px) per feature map.
pub const MIN_BOXES: [&[f32]; 4] = [
    &[10.0, 16.0, 24.0],
    &[32.0, 48.0],
    &[64.0, 96.0],
    &[128.0, 192.0, 256.0],
];

/// Strides of the four detection heads. Upstream `fd_config` tabulates the
/// feature-map sizes per input size; every table entry equals
/// `ceil(dim / stride)` for these strides, which is how we derive them.
const STRIDES: [usize; 4] = [8, 16, 32, 64];

/// Generates the SSD priors in center form, clamped to `[0, 1]`.
///
/// Exact port of `fd_config.define_img_size` + `box_utils.generate_priors`:
/// per feature-map index, then `j` over the map height, then `i` over the
/// width, then each `min_box`. `image_size` is `[width, height]`
/// (`[320, 240]` for the slim-320 detector, giving exactly 4420 priors).
/// Arithmetic runs in f64 like Python, then narrows to f32 like
/// `torch.tensor`.
pub fn generate_priors(image_size: [usize; 2]) -> Vec<CenterBox> {
    let [w, h] = image_size;
    let fm_w: Vec<usize> = STRIDES.iter().map(|s| w.div_ceil(*s)).collect();
    let fm_h: Vec<usize> = STRIDES.iter().map(|s| h.div_ceil(*s)).collect();

    let mut priors = Vec::new();
    for index in 0..STRIDES.len() {
        // Upstream: shrinkage = image_size / feature_map, scale = image_size / shrinkage.
        let scale_w = w as f64 / (w as f64 / fm_w[index] as f64);
        let scale_h = h as f64 / (h as f64 / fm_h[index] as f64);
        for j in 0..fm_h[index] {
            for i in 0..fm_w[index] {
                let x_center = (i as f64 + 0.5) / scale_w;
                let y_center = (j as f64 + 0.5) / scale_h;
                for &min_box in MIN_BOXES[index] {
                    let bw = min_box as f64 / w as f64;
                    let bh = min_box as f64 / h as f64;
                    priors.push([
                        (x_center as f32).clamp(0.0, 1.0),
                        (y_center as f32).clamp(0.0, 1.0),
                        (bw as f32).clamp(0.0, 1.0),
                        (bh as f32).clamp(0.0, 1.0),
                    ]);
                }
            }
        }
    }
    priors
}

/// Decodes SSD regression outputs into center-form boxes.
///
/// Port of `box_utils.convert_locations_to_boxes`:
/// `center = loc[..2] * center_variance * prior_wh + prior_center`,
/// `wh = exp(loc[2..] * size_variance) * prior_wh`.
pub fn decode_locations(
    locations: &[[f32; 4]],
    priors: &[CenterBox],
    center_variance: f32,
    size_variance: f32,
) -> Vec<CenterBox> {
    assert_eq!(locations.len(), priors.len(), "locations/priors mismatch");
    locations
        .iter()
        .zip(priors)
        .map(|(loc, prior)| {
            [
                loc[0] * center_variance * prior[2] + prior[0],
                loc[1] * center_variance * prior[3] + prior[1],
                (loc[2] * size_variance).exp() * prior[2],
                (loc[3] * size_variance).exp() * prior[3],
            ]
        })
        .collect()
}

/// Encodes a center-form box against a prior (inverse of the decode step).
///
/// Port of `box_utils.convert_boxes_to_locations`; used by round-trip tests.
pub fn encode_box(
    boxes: CenterBox,
    prior: CenterBox,
    center_variance: f32,
    size_variance: f32,
) -> [f32; 4] {
    [
        (boxes[0] - prior[0]) / prior[2] / center_variance,
        (boxes[1] - prior[1]) / prior[3] / center_variance,
        (boxes[2] / prior[2]).ln() / size_variance,
        (boxes[3] / prior[3]).ln() / size_variance,
    ]
}

/// Center form `[cx, cy, w, h]` → corner form (`center_form_to_corner_form`).
pub fn center_to_corner(b: CenterBox) -> BBox {
    BBox {
        x1: b[0] - b[2] / 2.0,
        y1: b[1] - b[3] / 2.0,
        x2: b[0] + b[2] / 2.0,
        y2: b[1] + b[3] / 2.0,
    }
}

/// Corner form → center form `[cx, cy, w, h]` (`corner_form_to_center_form`).
pub fn corner_to_center(b: BBox) -> CenterBox {
    [
        (b.x1 + b.x2) / 2.0,
        (b.y1 + b.y2) / 2.0,
        b.x2 - b.x1,
        b.y2 - b.y1,
    ]
}

/// Area of a corner-form box, clamped at zero (`box_utils.area_of`).
fn area_of(x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    (x2 - x1).max(0.0) * (y2 - y1).max(0.0)
}

/// Intersection-over-union of two corner-form boxes.
///
/// Port of `box_utils.iou_of` with its `eps = 1e-5` denominator guard and
/// zero-clamped areas.
pub fn iou(a: BBox, b: BBox) -> f32 {
    let overlap = area_of(
        a.x1.max(b.x1),
        a.y1.max(b.y1),
        a.x2.min(b.x2),
        a.y2.min(b.y2),
    );
    let area_a = area_of(a.x1, a.y1, a.x2, a.y2);
    let area_b = area_of(b.x1, b.y1, b.x2, b.y2);
    overlap / (area_a + area_b - overlap + 1e-5)
}

/// Hard non-maximum suppression, exact port of `box_utils.hard_nms`.
///
/// Sorts by score descending (stable), keeps the top `candidate_size`
/// candidates, then repeatedly picks the best remaining box and suppresses
/// the rest with IoU strictly greater than `iou_threshold`. `top_k <= 0`
/// keeps all survivors. Returns the picked detections in pick order.
pub fn hard_nms(
    detections: &[Detection],
    iou_threshold: f32,
    top_k: i32,
    candidate_size: usize,
) -> Vec<Detection> {
    let mut indexes: Vec<usize> = (0..detections.len()).collect();
    indexes.sort_by(|&a, &b| detections[b].score.total_cmp(&detections[a].score));
    indexes.truncate(candidate_size);

    let mut picked = Vec::new();
    while !indexes.is_empty() {
        let current = indexes[0];
        picked.push(detections[current]);
        if (top_k > 0 && picked.len() == top_k as usize) || indexes.len() == 1 {
            break;
        }
        let current_box = detections[current].bbox;
        indexes.remove(0);
        indexes.retain(|&i| iou(detections[i].bbox, current_box) <= iou_threshold);
    }
    picked
}

/// Parameters of the predict-time filtering chain, defaulting to the exact
/// values the upstream demo pipeline uses (ADR-0004).
#[derive(Debug, Clone, Copy)]
pub struct PostprocessParams {
    /// Class-1 probability threshold (`detect_imgs.threshold`).
    pub prob_threshold: f32,
    /// Hard-NMS suppression threshold (`fd_config.iou_threshold`).
    pub iou_threshold: f32,
    /// Keep at most this many faces; `<= 0` keeps all.
    pub top_k: i32,
    /// NMS candidate pool size.
    pub candidate_size: usize,
}

impl Default for PostprocessParams {
    fn default() -> Self {
        Self {
            prob_threshold: PROB_THRESHOLD,
            iou_threshold: IOU_THRESHOLD,
            top_k: TOP_K,
            candidate_size: CANDIDATE_SIZE,
        }
    }
}

/// Full detector post-processing: probability masking, hard NMS, scaling to
/// pixel coordinates, and the fully-inside-the-image validity filter.
///
/// Port of `Predictor.predict` (class 1 of 2) followed by
/// `detect_imgs.get_face_boundingbox`: keep class-1 probabilities strictly
/// above `prob_threshold`, NMS the survivors, scale `x` by `width` and `y`
/// by `height`, then keep only boxes with `x1 >= 0 && y1 >= 0 && x2 < width
/// && y2 < height`. `confidences` are softmaxed `[background, face]` rows;
/// `boxes` are relative corner-form boxes for the same priors.
pub fn postprocess(
    confidences: &[[f32; 2]],
    boxes: &[BBox],
    width: usize,
    height: usize,
    params: &PostprocessParams,
) -> Vec<Detection> {
    assert_eq!(confidences.len(), boxes.len(), "confidences/boxes mismatch");
    let candidates: Vec<Detection> = confidences
        .iter()
        .zip(boxes)
        .filter(|(conf, _)| conf[1] > params.prob_threshold)
        .map(|(conf, bbox)| Detection {
            bbox: *bbox,
            score: conf[1],
        })
        .collect();
    let picked = hard_nms(
        &candidates,
        params.iou_threshold,
        params.top_k,
        params.candidate_size,
    );

    let (w, h) = (width as f32, height as f32);
    picked
        .into_iter()
        .map(|d| Detection {
            bbox: BBox {
                x1: d.bbox.x1 * w,
                y1: d.bbox.y1 * h,
                x2: d.bbox.x2 * w,
                y2: d.bbox.y2 * h,
            },
            score: d.score,
        })
        .filter(|d| d.bbox.x1 >= 0.0 && d.bbox.y1 >= 0.0 && d.bbox.x2 < w && d.bbox.y2 < h)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bbox(x1: f32, y1: f32, x2: f32, y2: f32) -> BBox {
        BBox { x1, y1, x2, y2 }
    }

    fn det(x1: f32, y1: f32, x2: f32, y2: f32, score: f32) -> Detection {
        Detection {
            bbox: bbox(x1, y1, x2, y2),
            score,
        }
    }

    #[test]
    fn priors_count_is_4420_for_slim_320() {
        let priors = generate_priors([320, 240]);
        // (40*30)*3 + (20*15)*2 + (10*8)*2 + (5*4)*3
        assert_eq!(priors.len(), 4420);
    }

    #[test]
    fn priors_feature_maps_match_upstream_tables() {
        // Spot-check the ceil(dim/stride) derivation against fd_config's dicts.
        for (size, fm) in [
            ([320usize, 240usize], [[40, 20, 10, 5], [30, 15, 8, 4]]),
            ([128, 96], [[16, 8, 4, 2], [12, 6, 3, 2]]),
            ([480, 360], [[60, 30, 15, 8], [45, 23, 12, 6]]),
            ([640, 480], [[80, 40, 20, 10], [60, 30, 15, 8]]),
        ] {
            for (k, &s) in STRIDES.iter().enumerate() {
                assert_eq!(size[0].div_ceil(s), fm[0][k], "w fm for {size:?}");
                assert_eq!(size[1].div_ceil(s), fm[1][k], "h fm for {size:?}");
            }
        }
    }

    #[test]
    fn priors_first_values_hand_computed() {
        let priors = generate_priors([320, 240]);
        // index 0: scale_w = 40, scale_h = 30; cell (i=0, j=0).
        let expect = |cx: f64, cy: f64, w: f64, h: f64| [cx as f32, cy as f32, w as f32, h as f32];
        assert_eq!(
            priors[0],
            expect(0.5 / 40.0, 0.5 / 30.0, 10.0 / 320.0, 10.0 / 240.0)
        );
        assert_eq!(
            priors[1],
            expect(0.5 / 40.0, 0.5 / 30.0, 16.0 / 320.0, 16.0 / 240.0)
        );
        assert_eq!(
            priors[2],
            expect(0.5 / 40.0, 0.5 / 30.0, 24.0 / 320.0, 24.0 / 240.0)
        );
        // Cell (i=1, j=0) comes next: iteration is j, then i, then min_box.
        assert_eq!(
            priors[3],
            expect(1.5 / 40.0, 0.5 / 30.0, 10.0 / 320.0, 10.0 / 240.0)
        );
    }

    #[test]
    fn priors_last_value_hand_computed_and_clamped() {
        let priors = generate_priors([320, 240]);
        // Last prior: index 3 (fm 5x4), j=3, i=4, min_box 256.
        // h = 256/240 > 1 must clamp to 1.0.
        let last = priors[4419];
        assert_eq!(last[0], (4.5 / 5.0) as f32);
        assert_eq!(last[1], (3.5 / 4.0) as f32);
        assert_eq!(last[2], (256.0 / 320.0) as f32);
        assert_eq!(last[3], 1.0);
    }

    #[test]
    fn decode_encode_round_trip() {
        let priors = vec![
            [0.5, 0.5, 0.1, 0.2],
            [0.0125, 0.0166667, 0.03125, 0.0416667],
        ];
        let boxes = vec![[0.52, 0.47, 0.15, 0.18], [0.02, 0.03, 0.05, 0.06]];
        let locations: Vec<[f32; 4]> = boxes
            .iter()
            .zip(&priors)
            .map(|(b, p)| encode_box(*b, *p, CENTER_VARIANCE, SIZE_VARIANCE))
            .collect();
        let decoded = decode_locations(&locations, &priors, CENTER_VARIANCE, SIZE_VARIANCE);
        for (d, b) in decoded.iter().zip(&boxes) {
            for k in 0..4 {
                assert!((d[k] - b[k]).abs() < 1e-6, "decoded {d:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn decode_zero_locations_reproduce_priors() {
        let priors = generate_priors([320, 240]);
        let locations = vec![[0.0f32; 4]; priors.len()];
        let decoded = decode_locations(&locations, &priors, CENTER_VARIANCE, SIZE_VARIANCE);
        assert_eq!(decoded, priors);
    }

    #[test]
    fn corner_center_round_trip() {
        let c: CenterBox = [0.3, 0.4, 0.2, 0.1];
        let corner = center_to_corner(c);
        let expected = bbox(0.2, 0.35, 0.4, 0.45);
        for (got, want) in [
            (corner.x1, expected.x1),
            (corner.y1, expected.y1),
            (corner.x2, expected.x2),
            (corner.y2, expected.y2),
        ] {
            assert!((got - want).abs() < 1e-6, "{corner:?} vs {expected:?}");
        }
        let back = corner_to_center(corner);
        for k in 0..4 {
            assert!((back[k] - c[k]).abs() < 1e-6);
        }
    }

    #[test]
    fn iou_hand_cases() {
        let a = bbox(0.0, 0.0, 2.0, 2.0);
        // Identical boxes: 4 / (4 + 4 - 4 + eps) ≈ 1.
        assert!((iou(a, a) - 1.0).abs() < 1e-4);
        // Disjoint.
        assert_eq!(iou(a, bbox(3.0, 3.0, 4.0, 4.0)), 0.0);
        // Half overlap: inter 2, union 6.
        let b = bbox(1.0, 0.0, 3.0, 2.0);
        assert!((iou(a, b) - 2.0 / 6.0).abs() < 1e-4);
        // Touching edges: zero-area intersection.
        assert_eq!(iou(a, bbox(2.0, 0.0, 4.0, 2.0)), 0.0);
        // Degenerate (inverted) box clamps to zero area.
        assert_eq!(iou(bbox(2.0, 2.0, 1.0, 1.0), a), 0.0);
    }

    #[test]
    fn nms_suppresses_overlaps_keeps_disjoint() {
        let dets = vec![
            det(0.0, 0.0, 10.0, 10.0, 0.9),
            det(1.0, 1.0, 11.0, 11.0, 0.8), // IoU with first ~0.68 -> suppressed
            det(20.0, 20.0, 30.0, 30.0, 0.7), // disjoint -> kept
        ];
        let kept = hard_nms(&dets, 0.3, -1, 750);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0], dets[0]);
        assert_eq!(kept[1], dets[2]);
    }

    #[test]
    fn nms_iou_exactly_at_threshold_survives() {
        // Suppression is IoU > threshold (retain keeps <=).
        let a = det(0.0, 0.0, 2.0, 2.0, 0.9);
        let b = det(1.0, 0.0, 3.0, 2.0, 0.8); // IoU 1/3 with a
        let kept = hard_nms(&[a, b], 1.0 / 3.0, -1, 750);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn nms_candidate_size_truncates_low_scores() {
        // Three disjoint boxes, candidate_size 2: the lowest-scoring one is
        // dropped even though nothing overlaps it.
        let dets = vec![
            det(0.0, 0.0, 1.0, 1.0, 0.5),
            det(2.0, 2.0, 3.0, 3.0, 0.9),
            det(4.0, 4.0, 5.0, 5.0, 0.7),
        ];
        let kept = hard_nms(&dets, 0.3, -1, 2);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.9);
        assert_eq!(kept[1].score, 0.7);
    }

    #[test]
    fn nms_top_k_stops_early() {
        let dets = vec![
            det(0.0, 0.0, 1.0, 1.0, 0.9),
            det(2.0, 2.0, 3.0, 3.0, 0.8),
            det(4.0, 4.0, 5.0, 5.0, 0.7),
        ];
        let kept = hard_nms(&dets, 0.3, 2, 750);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.9);
        assert_eq!(kept[1].score, 0.8);
    }

    #[test]
    fn nms_empty_input() {
        assert!(hard_nms(&[], 0.3, -1, 750).is_empty());
    }

    #[test]
    fn postprocess_thresholds_nms_scales_and_filters() {
        let confidences = vec![
            [0.1, 0.9],   // face, kept
            [0.5, 0.5],   // below 0.6, masked out
            [0.15, 0.85], // face overlapping the first, NMS-suppressed
            [0.3, 0.7],   // face extending past the right edge, validity-filtered
        ];
        let boxes = vec![
            bbox(0.1, 0.1, 0.3, 0.4),
            bbox(0.6, 0.6, 0.8, 0.8),
            bbox(0.1, 0.1, 0.31, 0.41),
            bbox(0.7, 0.1, 1.0, 0.4), // x2 * 320 == 320, fails x2 < width
        ];
        let out = postprocess(
            &confidences,
            &boxes,
            320,
            240,
            &PostprocessParams::default(),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].score, 0.9);
        let b = out[0].bbox;
        assert!((b.x1 - 0.1 * 320.0).abs() < 1e-4);
        assert!((b.y1 - 0.1 * 240.0).abs() < 1e-4);
        assert!((b.x2 - 0.3 * 320.0).abs() < 1e-4);
        assert!((b.y2 - 0.4 * 240.0).abs() < 1e-4);
    }

    #[test]
    fn postprocess_threshold_is_strict() {
        let out = postprocess(
            &[[0.4, 0.6]],
            &[bbox(0.1, 0.1, 0.2, 0.2)],
            320,
            240,
            &PostprocessParams::default(),
        );
        assert!(out.is_empty(), "prob == threshold must not pass (strict >)");
    }

    #[test]
    fn postprocess_top_k_limits_faces() {
        let confidences = vec![[0.1, 0.9], [0.2, 0.8]];
        let boxes = vec![bbox(0.1, 0.1, 0.2, 0.2), bbox(0.5, 0.5, 0.6, 0.6)];
        let params = PostprocessParams {
            top_k: 1,
            ..Default::default()
        };
        let out = postprocess(&confidences, &boxes, 320, 240, &params);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].score, 0.9);
    }
}
