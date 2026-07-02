//! Eyes-level face alignment for the embedder.
//!
//! // reconstruction: upstream face_util is unpublished — behavior defined by
//! ADR-0004 from the call `align_vertical(image, W, H, out, 128, 128, 3,
//! landmarks, 48, 64, 40)`: a similarity transform placing the eye centers
//! horizontal with midpoint (64, 48) and inter-eye distance 40 px in a
//! 128×128 output, rendered by inverse mapping with bilinear sampling and
//! edge clamp.

use crate::image::{round_u8, Image};

/// 68 facial landmarks as `[x, y]` points in pixel coordinates.
///
/// This is the crate's canonical layout. The upstream landmark vector is 136
/// floats; use [`landmarks_from_interleaved`] for `x0,y0,x1,y1,…` buffers and
/// [`landmarks_from_split`] for `x0…x67,y0…y67` buffers.
pub type Landmarks = [[f32; 2]; 68];

/// Output width/height of the aligned crop.
pub const ALIGN_SIZE: usize = 128;
/// Target y of both eye centers in the aligned crop.
pub const ALIGN_EYE_Y: f32 = 48.0;
/// Target x of the eye midpoint in the aligned crop.
pub const ALIGN_EYE_CENTER_X: f32 = 64.0;
/// Target inter-eye distance (px) in the aligned crop.
pub const ALIGN_EYE_DIST: f32 = 40.0;

/// Converts a 136-float `x0,y0,x1,y1,…` buffer to [`Landmarks`].
///
/// Panics if `v.len() != 136`.
pub fn landmarks_from_interleaved(v: &[f32]) -> Landmarks {
    assert_eq!(v.len(), 136, "expected 136 floats");
    let mut out = [[0.0f32; 2]; 68];
    for (i, p) in out.iter_mut().enumerate() {
        *p = [v[2 * i], v[2 * i + 1]];
    }
    out
}

/// Converts a 136-float `x0…x67,y0…y67` buffer to [`Landmarks`].
///
/// Panics if `v.len() != 136`.
pub fn landmarks_from_split(v: &[f32]) -> Landmarks {
    assert_eq!(v.len(), 136, "expected 136 floats");
    let mut out = [[0.0f32; 2]; 68];
    for (i, p) in out.iter_mut().enumerate() {
        *p = [v[i], v[68 + i]];
    }
    out
}

/// Eye centers as the means of landmarks 36–41 (left, image-left) and 42–47
/// (right), in source-image coordinates.
pub fn eye_centers(landmarks: &Landmarks) -> ([f32; 2], [f32; 2]) {
    let mean = |range: core::ops::RangeInclusive<usize>| {
        let mut cx = 0.0;
        let mut cy = 0.0;
        for i in range.clone() {
            cx += landmarks[i][0];
            cy += landmarks[i][1];
        }
        let n = (range.end() - range.start() + 1) as f32;
        [cx / n, cy / n]
    };
    (mean(36..=41), mean(42..=47))
}

/// 2-D similarity transform `dst = s·R(θ)·src + t`.
#[derive(Debug, Clone, Copy)]
pub struct SimilarityTransform {
    /// Uniform scale.
    pub scale: f32,
    /// Rotation angle θ (radians); the matrix is `[[cos, -sin], [sin, cos]]`.
    pub angle: f32,
    /// Translation, applied after rotation and scaling.
    pub translation: [f32; 2],
}

impl SimilarityTransform {
    /// Maps a source-image point into the aligned crop.
    pub fn apply(&self, p: [f32; 2]) -> [f32; 2] {
        let (sin, cos) = self.angle.sin_cos();
        [
            self.scale * (cos * p[0] - sin * p[1]) + self.translation[0],
            self.scale * (sin * p[0] + cos * p[1]) + self.translation[1],
        ]
    }

    /// Maps an aligned-crop point back into the source image.
    pub fn apply_inverse(&self, p: [f32; 2]) -> [f32; 2] {
        let (sin, cos) = self.angle.sin_cos();
        let dx = (p[0] - self.translation[0]) / self.scale;
        let dy = (p[1] - self.translation[1]) / self.scale;
        // R(-θ) · d.
        [cos * dx + sin * dy, -sin * dx + cos * dy]
    }
}

/// Computes the alignment transform for a face: eye midpoint →
/// `(center_x, eye_y)`, inter-eye distance → `eye_dist`, eye line horizontal.
///
/// Returns `None` when the eye centers coincide (degenerate landmarks).
pub fn compute_alignment(
    landmarks: &Landmarks,
    eye_y: f32,
    center_x: f32,
    eye_dist: f32,
) -> Option<SimilarityTransform> {
    let (left, right) = eye_centers(landmarks);
    let dx = right[0] - left[0];
    let dy = right[1] - left[1];
    let dist = (dx * dx + dy * dy).sqrt();
    if dist <= f32::EPSILON {
        return None;
    }
    let scale = eye_dist / dist;
    // Rotate by -θ so the eye line becomes horizontal.
    let angle = -dy.atan2(dx);
    let mid = [(left[0] + right[0]) / 2.0, (left[1] + right[1]) / 2.0];
    let (sin, cos) = angle.sin_cos();
    let translation = [
        center_x - scale * (cos * mid[0] - sin * mid[1]),
        eye_y - scale * (sin * mid[0] + cos * mid[1]),
    ];
    Some(SimilarityTransform {
        scale,
        angle,
        translation,
    })
}

/// Renders an aligned crop of arbitrary geometry by inverse mapping with
/// bilinear sampling and edge clamp. Channel order is preserved (upstream
/// feeds BGR in, BGR comes out). Degenerate landmarks yield a black crop.
pub fn align_with(
    image: &Image,
    landmarks: &Landmarks,
    out_w: usize,
    out_h: usize,
    eye_y: f32,
    center_x: f32,
    eye_dist: f32,
) -> Image {
    let mut out = Image::zeros(out_w, out_h, image.channels);
    let Some(t) = compute_alignment(landmarks, eye_y, center_x, eye_dist) else {
        return out;
    };
    let max_x = (image.width - 1) as f32;
    let max_y = (image.height - 1) as f32;
    for v in 0..out_h {
        for u in 0..out_w {
            let src = t.apply_inverse([u as f32, v as f32]);
            let sx = src[0].clamp(0.0, max_x);
            let sy = src[1].clamp(0.0, max_y);
            let x0 = sx.floor() as usize;
            let y0 = sy.floor() as usize;
            let x1 = (x0 + 1).min(image.width - 1);
            let y1 = (y0 + 1).min(image.height - 1);
            let fx = sx - x0 as f32;
            let fy = sy - y0 as f32;
            for c in 0..image.channels {
                let p00 = image.get(x0, y0, c) as f32;
                let p10 = image.get(x1, y0, c) as f32;
                let p01 = image.get(x0, y1, c) as f32;
                let p11 = image.get(x1, y1, c) as f32;
                let top = p00 + (p10 - p00) * fx;
                let bot = p01 + (p11 - p01) * fx;
                out.set(u, v, c, round_u8(top + (bot - top) * fy));
            }
        }
    }
    out
}

/// The pipeline's alignment: 128×128 crop with eyes at (44, 48) and (84, 48).
///
/// Reconstruction of upstream `align_vertical(image, W, H, out, 128, 128, 3,
/// landmarks, 48, 64, 40)` per ADR-0004.
// reconstruction: upstream face_util is unpublished
pub fn align_vertical(image: &Image, landmarks: &Landmarks) -> Image {
    align_with(
        image,
        landmarks,
        ALIGN_SIZE,
        ALIGN_SIZE,
        ALIGN_EYE_Y,
        ALIGN_EYE_CENTER_X,
        ALIGN_EYE_DIST,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic landmarks whose eye points are spread around given centers.
    fn landmarks_with_eyes(left: [f32; 2], right: [f32; 2]) -> Landmarks {
        let mut lm = [[0.0f32; 2]; 68];
        // Offsets summing to zero so the six-point mean is the center itself.
        let offs = [
            [-2.0, 0.0],
            [-1.0, -1.0],
            [1.0, -1.0],
            [2.0, 0.0],
            [1.0, 1.0],
            [-1.0, 1.0],
        ];
        for (k, o) in offs.iter().enumerate() {
            lm[36 + k] = [left[0] + o[0], left[1] + o[1]];
            lm[42 + k] = [right[0] + o[0], right[1] + o[1]];
        }
        lm
    }

    #[test]
    fn landmark_layout_converters_agree() {
        let mut interleaved = [0.0f32; 136];
        let mut split = [0.0f32; 136];
        for i in 0..68 {
            let (x, y) = (i as f32, 100.0 + i as f32);
            interleaved[2 * i] = x;
            interleaved[2 * i + 1] = y;
            split[i] = x;
            split[68 + i] = y;
        }
        let a = landmarks_from_interleaved(&interleaved);
        let b = landmarks_from_split(&split);
        assert_eq!(a, b);
        assert_eq!(a[5], [5.0, 105.0]);
    }

    #[test]
    fn eye_centers_are_six_point_means() {
        let lm = landmarks_with_eyes([100.0, 120.0], [150.0, 118.0]);
        let (l, r) = eye_centers(&lm);
        assert!((l[0] - 100.0).abs() < 1e-4 && (l[1] - 120.0).abs() < 1e-4);
        assert!((r[0] - 150.0).abs() < 1e-4 && (r[1] - 118.0).abs() < 1e-4);
    }

    /// Property test (ADR-0006): under the computed transform the eye centers
    /// land at (44, 48) and (84, 48) within 0.5 px, for rotated/scaled faces.
    #[test]
    fn alignment_places_eyes_at_44_and_84() {
        let cases = [
            ([100.0, 100.0], [140.0, 100.0]),   // canonical, dist 40
            ([100.0, 100.0], [180.0, 100.0]),   // 2x scale
            ([100.0, 100.0], [128.28, 128.28]), // 45 deg tilt
            ([200.0, 150.0], [180.0, 90.0]),    // steep tilt, mirrored order
            ([50.0, 50.0], [50.0, 90.0]),       // vertical eye line
        ];
        for (left, right) in cases {
            let lm = landmarks_with_eyes(left, right);
            let t = compute_alignment(&lm, ALIGN_EYE_Y, ALIGN_EYE_CENTER_X, ALIGN_EYE_DIST)
                .expect("non-degenerate");
            let (l, r) = eye_centers(&lm);
            let lt = t.apply(l);
            let rt = t.apply(r);
            assert!(
                (lt[0] - 44.0).abs() < 0.5 && (lt[1] - 48.0).abs() < 0.5,
                "left eye mapped to {lt:?} for {left:?}/{right:?}"
            );
            assert!(
                (rt[0] - 84.0).abs() < 0.5 && (rt[1] - 48.0).abs() < 0.5,
                "right eye mapped to {rt:?} for {left:?}/{right:?}"
            );
        }
    }

    #[test]
    fn transform_inverse_round_trips() {
        let lm = landmarks_with_eyes([90.0, 110.0], [130.0, 130.0]);
        let t = compute_alignment(&lm, 48.0, 64.0, 40.0).unwrap();
        for p in [[0.0, 0.0], [64.0, 48.0], [127.0, 127.0]] {
            let q = t.apply(t.apply_inverse(p));
            assert!((q[0] - p[0]).abs() < 1e-3 && (q[1] - p[1]).abs() < 1e-3);
        }
    }

    #[test]
    fn align_translation_only_copies_pixels() {
        // Eyes at (100,100)/(140,100): dist 40, horizontal -> pure translation
        // by (-56, -52). Output (44,48) == src (100,100), (84,48) == (140,100).
        let mut img = Image::zeros(256, 256, 3);
        img.set(100, 100, 0, 201);
        img.set(140, 100, 0, 202);
        img.set(120, 100, 1, 203); // midpoint -> (64, 48)
        let lm = landmarks_with_eyes([100.0, 100.0], [140.0, 100.0]);
        let out = align_vertical(&img, &lm);
        assert_eq!(out.width, 128);
        assert_eq!(out.height, 128);
        assert_eq!(out.channels, 3);
        assert_eq!(out.get(44, 48, 0), 201);
        assert_eq!(out.get(84, 48, 0), 202);
        assert_eq!(out.get(64, 48, 1), 203);
    }

    #[test]
    fn align_vertical_eye_line_rotates_into_place() {
        // Eyes stacked vertically (90 deg roll): left at (100,100), right at
        // (100,140). Marked pixels must land on the horizontal eye row.
        let mut img = Image::zeros(256, 256, 1);
        img.set(100, 100, 0, 111);
        img.set(100, 140, 0, 122);
        let lm = landmarks_with_eyes([100.0, 100.0], [100.0, 140.0]);
        let out = align_vertical(&img, &lm);
        assert_eq!(out.get(44, 48, 0), 111);
        assert_eq!(out.get(84, 48, 0), 122);
    }

    #[test]
    fn align_edge_clamps_outside_samples() {
        // Face near the origin: much of the crop maps outside the source and
        // must replicate the border instead of wrapping or panicking.
        let mut img = Image::zeros(64, 64, 1);
        for p in img.data.iter_mut() {
            *p = 55;
        }
        let lm = landmarks_with_eyes([10.0, 10.0], [50.0, 10.0]);
        let out = align_vertical(&img, &lm);
        assert!(out.data.iter().all(|&p| p == 55));
    }

    #[test]
    fn align_degenerate_landmarks_yield_black() {
        let img = Image::zeros(64, 64, 3);
        let lm = landmarks_with_eyes([30.0, 30.0], [30.0, 30.0]);
        let out = align_vertical(&img, &lm);
        assert!(out.data.iter().all(|&p| p == 0));
        assert_eq!(out.width, 128);
    }
}
