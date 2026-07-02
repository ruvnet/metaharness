//! Dependency-free image container and the OpenCV-compatible operations the
//! pipeline needs: bilinear resize, channel swaps, grayscale, and HWC u8 →
//! NCHW f32 normalization (ADR-0004).

/// Detector input normalization mean (`fd_config.image_mean`, all channels).
pub const DETECTOR_MEAN: [f32; 3] = [127.0, 127.0, 127.0];
/// Detector input normalization scale (`1 / fd_config.image_std`).
pub const DETECTOR_SCALE: f32 = 1.0 / 128.0;
/// Embedder input scale: upstream divides by **256** (not 255), preserved
/// deliberately (ADR-0004).
pub const EMBEDDER_SCALE: f32 = 1.0 / 256.0;
/// Landmark-net input scale (crops scaled to `[0, 1]`).
pub const LANDMARK_SCALE: f32 = 1.0 / 255.0;

/// Error for invalid image construction.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImageError {
    /// Buffer length does not equal `width * height * channels`.
    #[error("data length {len} != {width}x{height}x{channels}")]
    SizeMismatch {
        len: usize,
        width: usize,
        height: usize,
        channels: usize,
    },
}

/// Owned 8-bit image, interleaved channels, row-major (HWC), matching the
/// memory layout of an OpenCV `Mat`/numpy `[H, W, C]` array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub channels: usize,
}

impl Image {
    /// Wraps an existing interleaved buffer, validating its length.
    pub fn new(
        data: Vec<u8>,
        width: usize,
        height: usize,
        channels: usize,
    ) -> Result<Self, ImageError> {
        if data.len() != width * height * channels {
            return Err(ImageError::SizeMismatch {
                len: data.len(),
                width,
                height,
                channels,
            });
        }
        Ok(Self {
            data,
            width,
            height,
            channels,
        })
    }

    /// All-zero image of the given shape.
    pub fn zeros(width: usize, height: usize, channels: usize) -> Self {
        Self {
            data: vec![0; width * height * channels],
            width,
            height,
            channels,
        }
    }

    /// Pixel accessor; `x < width`, `y < height`, `c < channels`.
    #[inline]
    pub fn get(&self, x: usize, y: usize, c: usize) -> u8 {
        self.data[(y * self.width + x) * self.channels + c]
    }

    /// Mutable pixel accessor.
    #[inline]
    pub fn set(&mut self, x: usize, y: usize, c: usize, v: u8) {
        self.data[(y * self.width + x) * self.channels + c] = v;
    }
}

/// Rounds like OpenCV's u8 saturate on non-negative values: half away from
/// zero (== half up here), then clamps to `[0, 255]`.
#[inline]
pub(crate) fn round_u8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Source taps and interpolation weight for one destination coordinate under
/// `cv2.resize` INTER_LINEAR: `src = (dst + 0.5) * scale - 0.5`, taps clamped
/// to the valid range (border replicate).
#[inline]
fn linear_taps(dst: usize, scale: f64, src_len: usize) -> (usize, usize, f32) {
    let f = (dst as f64 + 0.5) * scale - 0.5;
    let i = f.floor();
    let frac = (f - i) as f32;
    let max = (src_len - 1) as f64;
    let i0 = i.clamp(0.0, max) as usize;
    let i1 = (i + 1.0).clamp(0.0, max) as usize;
    (i0, i1, frac)
}

/// Bilinear-resamples one channel-interleaved image into an f32 HWC buffer.
fn resize_bilinear_impl(src: &Image, dst_w: usize, dst_h: usize) -> Vec<f32> {
    assert!(src.width > 0 && src.height > 0 && dst_w > 0 && dst_h > 0);
    let c = src.channels;
    let scale_x = src.width as f64 / dst_w as f64;
    let scale_y = src.height as f64 / dst_h as f64;
    let mut out = Vec::with_capacity(dst_w * dst_h * c);
    for y in 0..dst_h {
        let (y0, y1, fy) = linear_taps(y, scale_y, src.height);
        for x in 0..dst_w {
            let (x0, x1, fx) = linear_taps(x, scale_x, src.width);
            for ch in 0..c {
                let p00 = src.get(x0, y0, ch) as f32;
                let p10 = src.get(x1, y0, ch) as f32;
                let p01 = src.get(x0, y1, ch) as f32;
                let p11 = src.get(x1, y1, ch) as f32;
                let top = p00 + (p10 - p00) * fx;
                let bot = p01 + (p11 - p01) * fx;
                out.push(top + (bot - top) * fy);
            }
        }
    }
    out
}

/// Bilinear resize matching `cv2.resize(..., interpolation=INTER_LINEAR)`
/// semantics: source coordinate `(dst + 0.5) * scale - 0.5`, border
/// replicate, final value rounded half away from zero.
///
/// Residual off-by-one risk vs OpenCV: OpenCV computes INTER_LINEAR on u8 in
/// fixed point (weights quantized to 11 bits, accumulator rounded half up at
/// 22 bits). This float implementation can differ by ±1 on values whose
/// fixed-point weighted sum lands on the other side of a rounding boundary;
/// use [`resize_bilinear_f32`] where quantization matters (network inputs).
pub fn resize_bilinear(src: &Image, dst_w: usize, dst_h: usize) -> Image {
    let data = resize_bilinear_impl(src, dst_w, dst_h)
        .into_iter()
        .map(round_u8)
        .collect();
    Image {
        data,
        width: dst_w,
        height: dst_h,
        channels: src.channels,
    }
}

/// [`resize_bilinear`] without the final u8 quantization: returns the raw
/// interpolated values as an HWC f32 buffer, for feeding networks directly.
pub fn resize_bilinear_f32(src: &Image, dst_w: usize, dst_h: usize) -> Vec<f32> {
    resize_bilinear_impl(src, dst_w, dst_h)
}

/// Swaps the first and third channels in place: BGR↔RGB
/// (`cv2.cvtColor(..., COLOR_BGR2RGB)` and its inverse).
pub fn swap_rb(img: &mut Image) {
    assert_eq!(img.channels, 3, "swap_rb requires a 3-channel image");
    for px in img.data.chunks_exact_mut(3) {
        px.swap(0, 2);
    }
}

/// 3-channel → grayscale with the OpenCV BT.601 coefficients
/// `0.299 R + 0.587 G + 0.114 B`, rounded. `r_index` selects where red
/// lives: 0 for RGB input, 2 for BGR input.
fn to_gray(img: &Image, r_index: usize) -> Image {
    assert_eq!(img.channels, 3, "grayscale conversion requires 3 channels");
    let data = img
        .data
        .chunks_exact(3)
        .map(|px| {
            let r = px[r_index] as f32;
            let g = px[1] as f32;
            let b = px[2 - r_index] as f32;
            round_u8(0.299 * r + 0.587 * g + 0.114 * b)
        })
        .collect();
    Image {
        data,
        width: img.width,
        height: img.height,
        channels: 1,
    }
}

/// RGB → grayscale (`0.299 R + 0.587 G + 0.114 B`, rounded).
pub fn rgb_to_gray(img: &Image) -> Image {
    to_gray(img, 0)
}

/// BGR → grayscale, same coefficients as [`rgb_to_gray`]
/// (`cv2.cvtColor(..., COLOR_BGR2GRAY)`).
pub fn bgr_to_gray(img: &Image) -> Image {
    to_gray(img, 2)
}

/// HWC u8 → CHW f32 normalization: `out = (px - mean[c]) * scale`, laid out
/// `[C, H, W]` (a single NCHW batch element).
///
/// Pipeline settings: detector `mean = [127; 3]`, `scale = 1/128`; embedder
/// `mean = [0; 3]`, `scale = 1/256`; landmark net `mean = [0]`,
/// `scale = 1/255`.
pub fn to_chw_f32(img: &Image, mean: &[f32], scale: f32) -> Vec<f32> {
    assert_eq!(
        mean.len(),
        img.channels,
        "mean must have one entry per channel"
    );
    let (w, h, c) = (img.width, img.height, img.channels);
    let mut out = vec![0.0f32; w * h * c];
    for y in 0..h {
        for x in 0..w {
            for ch in 0..c {
                out[ch * h * w + y * w + x] = (img.get(x, y, ch) as f32 - mean[ch]) * scale;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gray_image(pixels: &[u8], width: usize, height: usize) -> Image {
        Image::new(pixels.to_vec(), width, height, 1).unwrap()
    }

    #[test]
    fn new_validates_length() {
        assert!(Image::new(vec![0; 12], 2, 2, 3).is_ok());
        assert_eq!(
            Image::new(vec![0; 11], 2, 2, 3),
            Err(ImageError::SizeMismatch {
                len: 11,
                width: 2,
                height: 2,
                channels: 3
            })
        );
    }

    #[test]
    fn resize_identity_is_exact() {
        let src = gray_image(&[10, 20, 30, 40, 50, 60], 3, 2);
        let dst = resize_bilinear(&src, 3, 2);
        assert_eq!(dst, src);
    }

    #[test]
    fn resize_upscale_gradient_hand_computed() {
        // 2x1 -> 4x1, scale 0.5: fx = (x+0.5)*0.5-0.5 = -0.25, 0.25, 0.75, 1.25.
        // Edge taps replicate; interior interpolates the [0, 100] gradient.
        let src = gray_image(&[0, 100], 2, 1);
        let dst = resize_bilinear(&src, 4, 1);
        assert_eq!(dst.data, vec![0, 25, 75, 100]);
    }

    #[test]
    fn resize_downscale_gradient_hand_computed() {
        // 4x1 -> 2x1, scale 2: fx = 0.5 and 2.5 -> midpoints of (p0,p1), (p2,p3).
        let src = gray_image(&[0, 40, 80, 120], 4, 1);
        let dst = resize_bilinear(&src, 2, 1);
        assert_eq!(dst.data, vec![20, 100]);
    }

    #[test]
    fn resize_vertical_matches_horizontal_semantics() {
        let src = gray_image(&[0, 100], 1, 2);
        let dst = resize_bilinear(&src, 1, 4);
        assert_eq!(dst.data, vec![0, 25, 75, 100]);
    }

    #[test]
    fn resize_rounds_half_away_from_zero() {
        // 2x1 -> 4x1 on [0, 1]: interior values 0.25 and 0.75 round to 0 and 1.
        let src = gray_image(&[0, 1], 2, 1);
        let dst = resize_bilinear(&src, 4, 1);
        assert_eq!(dst.data, vec![0, 0, 1, 1]);
        // 0.5 exactly rounds up: [0, 2] -> interior 0.5, 1.5 -> 1, 2.
        let src = gray_image(&[0, 2], 2, 1);
        let dst = resize_bilinear(&src, 4, 1);
        assert_eq!(dst.data, vec![0, 1, 2, 2]);
    }

    #[test]
    fn resize_f32_keeps_fractions() {
        let src = gray_image(&[0, 1], 2, 1);
        let dst = resize_bilinear_f32(&src, 4, 1);
        assert_eq!(dst, vec![0.0, 0.25, 0.75, 1.0]);
    }

    #[test]
    fn resize_multichannel_interleaving_preserved() {
        // 1x1 RGB -> 2x2: every output pixel replicates the single source px.
        let src = Image::new(vec![7, 8, 9], 1, 1, 3).unwrap();
        let dst = resize_bilinear(&src, 2, 2);
        assert_eq!(dst.data, vec![7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9]);
    }

    #[test]
    fn resize_2d_bilinear_center() {
        // 2x2 -> 3x3: center output samples fx=fy=0.5 over all four corners.
        let src = gray_image(&[0, 100, 100, 200], 2, 2);
        let dst = resize_bilinear_f32(&src, 3, 3);
        // Center: fy = (1.5)*(2/3) - 0.5 = 0.5, fx same -> mean of corners.
        assert_eq!(dst[4], 100.0);
        // Corners replicate.
        assert_eq!(dst[0], 0.0);
        assert_eq!(dst[8], 200.0);
    }

    #[test]
    fn swap_rb_swaps_first_and_third() {
        let mut img = Image::new(vec![1, 2, 3, 4, 5, 6], 2, 1, 3).unwrap();
        swap_rb(&mut img);
        assert_eq!(img.data, vec![3, 2, 1, 6, 5, 4]);
    }

    #[test]
    fn grayscale_coefficients_and_rounding() {
        // Pure R, G, B pixels at 255, plus a rounding case.
        let rgb = Image::new(vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 1, 1], 4, 1, 3).unwrap();
        let gray = rgb_to_gray(&rgb);
        // 0.299*255 = 76.245 -> 76; 0.587*255 = 149.685 -> 150;
        // 0.114*255 = 29.07 -> 29; 0.299+0.587+0.114 = 1.0 -> 1.
        assert_eq!(gray.data, vec![76, 150, 29, 1]);
        assert_eq!(gray.channels, 1);

        // Same pixels in BGR order must give the same result via bgr_to_gray.
        let bgr = Image::new(vec![0, 0, 255, 0, 255, 0, 255, 0, 0, 1, 1, 1], 4, 1, 3).unwrap();
        assert_eq!(bgr_to_gray(&bgr).data, gray.data);
    }

    #[test]
    fn to_chw_layout_and_detector_normalization() {
        // 2x1 RGB image: pixel0 = (127, 255, 0), pixel1 = (127, 0, 255).
        let img = Image::new(vec![127, 255, 0, 127, 0, 255], 2, 1, 3).unwrap();
        let chw = to_chw_f32(&img, &DETECTOR_MEAN, DETECTOR_SCALE);
        assert_eq!(chw.len(), 6);
        // Channel 0 plane: both pixels 127 -> 0.
        assert_eq!(&chw[0..2], &[0.0, 0.0]);
        // Channel 1 plane: (255-127)/128 = 1, (0-127)/128.
        assert_eq!(chw[2], 1.0);
        assert_eq!(chw[3], -127.0 / 128.0);
        // Channel 2 plane.
        assert_eq!(chw[4], -127.0 / 128.0);
        assert_eq!(chw[5], 1.0);
    }

    #[test]
    fn to_chw_embedder_and_landmark_scales() {
        let img = Image::new(vec![128, 128, 128], 1, 1, 3).unwrap();
        let emb = to_chw_f32(&img, &[0.0; 3], EMBEDDER_SCALE);
        assert_eq!(emb, vec![0.5, 0.5, 0.5]);

        let gray = Image::new(vec![255], 1, 1, 1).unwrap();
        let lmk = to_chw_f32(&gray, &[0.0], LANDMARK_SCALE);
        assert_eq!(lmk, vec![1.0]);
    }
}
