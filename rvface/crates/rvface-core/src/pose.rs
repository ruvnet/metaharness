//! Head pose (yaw/pitch/roll) from 68 facial landmarks.
//!
//! // reconstruction: upstream face_util is unpublished — behavior defined by
//! ADR-0004: an orthographic least-squares fit of the observed 2-D landmarks
//! against a canonical 3-D 68-point face template (no camera intrinsics, as
//! upstream never had any).
//!
//! Conventions: everything lives in an image-like right-handed frame with
//! x right, y **down**, z **into** the screen (so the nose points toward
//! negative z, at the camera). The fitted rotation is decomposed as
//! `R = Ry(yaw) · Rx(pitch) · Rz(roll)`; with y down, positive roll is a
//! clockwise on-screen tilt and equals the eye-line angle
//! `atan2(right.y - left.y, right.x - left.x)` for pure in-plane rotation.

use crate::align::{eye_centers, Landmarks};

/// Head pose angles in degrees.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Pose {
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
}

/// Canonical 3-D 68-point face template (the widely used OpenFace-derived
/// model, e.g. yinguobing/head-pose-estimation `assets/model.txt`), stored
/// as `[x, y, z]` per point in the frame documented at module level
/// (x right, y down, z into screen; units are arbitrary mm-like lengths).
#[allow(clippy::excessive_precision)] // values verbatim from the reference model
pub const FACE_TEMPLATE_3D: [[f32; 3]; 68] = [
    [-73.393523, -29.801432, 47.667532],
    [-72.775014, -10.949766, 45.909403],
    [-70.533638, 7.929818, 44.842580],
    [-66.850058, 26.074280, 43.141114],
    [-59.790187, 42.564390, 38.635298],
    [-48.368973, 56.481080, 30.750622],
    [-34.121101, 67.246992, 18.456453],
    [-17.875411, 75.056892, 3.609035],
    [0.098749, 77.061286, -0.881698],
    [17.477031, 74.758448, 5.181201],
    [32.648966, 66.929021, 19.176563],
    [46.372358, 56.311389, 30.770570],
    [57.343480, 42.419126, 37.628629],
    [64.388482, 25.455880, 40.886309],
    [68.212038, 6.990805, 42.281449],
    [70.486405, -11.666193, 44.142567],
    [71.375822, -30.365191, 47.140426],
    [-61.119406, -49.361602, 14.254422],
    [-51.287588, -58.769795, 7.268147],
    [-37.804800, -61.996155, 0.442051],
    [-24.022754, -61.033399, -6.606501],
    [-11.635713, -56.686759, -11.967398],
    [12.056636, -57.391033, -12.051204],
    [25.106256, -61.902186, -7.315098],
    [38.338588, -62.777713, -1.022953],
    [51.191007, -59.302347, 5.349435],
    [60.053851, -50.190255, 11.615746],
    [0.653940, -42.193790, -13.380835],
    [0.804809, -30.993721, -21.150853],
    [0.992204, -19.944596, -29.284036],
    [1.226783, -8.414541, -36.948060],
    [-14.772472, 2.598255, -20.132003],
    [-7.180239, 4.751589, -23.536684],
    [0.555920, 6.562900, -25.944448],
    [8.272499, 4.661005, -23.695741],
    [15.214351, 2.643046, -20.858157],
    [-46.047290, -37.471411, 7.037989],
    [-37.674688, -42.730510, 3.021217],
    [-27.883856, -42.711517, 1.353629],
    [-19.648268, -36.754742, -0.111088],
    [-28.272965, -35.134493, -0.147273],
    [-38.082418, -34.919043, 1.476612],
    [19.265868, -37.032306, -0.665746],
    [27.894191, -43.342445, 0.247660],
    [37.437529, -43.110822, 1.696435],
    [45.170805, -38.086515, 4.894163],
    [38.196454, -35.532024, 0.282961],
    [28.764989, -35.484289, -1.172675],
    [-28.916267, 28.612716, -2.240310],
    [-17.533194, 22.172187, -15.934335],
    [-6.684590, 19.029051, -22.611355],
    [0.381001, 20.721118, -23.748437],
    [8.375443, 19.035460, -22.721995],
    [18.876618, 22.394109, -15.610679],
    [28.794412, 28.079924, -3.217393],
    [19.057574, 36.298248, -14.987997],
    [8.956375, 39.634575, -22.554245],
    [0.381549, 40.395647, -23.591626],
    [-7.428895, 39.836405, -22.406106],
    [-18.160634, 36.677899, -15.121907],
    [-24.377490, 28.677771, -4.785684],
    [-6.897633, 25.475976, -20.893742],
    [0.340663, 26.014269, -22.220479],
    [8.444722, 25.326198, -21.025520],
    [24.474473, 28.323008, -5.712776],
    [8.449166, 30.596216, -20.671489],
    [0.205322, 31.408738, -21.903670],
    [-7.198266, 30.844876, -20.328022],
];

/// Inverts a symmetric 3×3 matrix via its adjugate. Returns `None` when
/// singular (can only happen for degenerate landmark templates).
fn invert3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1];
    let c01 = m[1][2] * m[2][0] - m[1][0] * m[2][2];
    let c02 = m[1][0] * m[2][1] - m[1][1] * m[2][0];
    let det = m[0][0] * c00 + m[0][1] * c01 + m[0][2] * c02;
    if det.abs() < 1e-12 {
        return None;
    }
    let inv_det = 1.0 / det;
    let c10 = m[0][2] * m[2][1] - m[0][1] * m[2][2];
    let c11 = m[0][0] * m[2][2] - m[0][2] * m[2][0];
    let c12 = m[0][1] * m[2][0] - m[0][0] * m[2][1];
    let c20 = m[0][1] * m[1][2] - m[0][2] * m[1][1];
    let c21 = m[0][2] * m[1][0] - m[0][0] * m[1][2];
    let c22 = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    Some([
        [c00 * inv_det, c10 * inv_det, c20 * inv_det],
        [c01 * inv_det, c11 * inv_det, c21 * inv_det],
        [c02 * inv_det, c12 * inv_det, c22 * inv_det],
    ])
}

fn normalize3(v: [f64; 3]) -> [f64; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / n, v[1] / n, v[2] / n]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Estimates yaw/pitch/roll (degrees) from 68 landmarks.
///
/// Method: center both point sets, solve the 2×3 orthographic camera matrix
/// `M = A·B⁻¹` minimizing `‖p − M·X‖²` (`A = Σ p·Xᵀ`, `B = Σ X·Xᵀ`), then
/// factor out the uniform scale, orthonormalize the two rows symmetrically,
/// complete the rotation with their cross product, and decompose it as
/// `Ry(yaw)·Rx(pitch)·Rz(roll)`.
// reconstruction: upstream face_util is unpublished
pub fn estimate_pose(landmarks: &Landmarks) -> Pose {
    // Centroids.
    let mut pc = [0.0f64; 2];
    let mut xc = [0.0f64; 3];
    for (p, x) in landmarks.iter().zip(&FACE_TEMPLATE_3D) {
        pc[0] += p[0] as f64;
        pc[1] += p[1] as f64;
        for (acc, v) in xc.iter_mut().zip(x) {
            *acc += *v as f64;
        }
    }
    pc[0] /= 68.0;
    pc[1] /= 68.0;
    for k in xc.iter_mut() {
        *k /= 68.0;
    }

    // A = Σ p_c · X_cᵀ (2×3), B = Σ X_c · X_cᵀ (3×3).
    let mut a = [[0.0f64; 3]; 2];
    let mut b = [[0.0f64; 3]; 3];
    for i in 0..68 {
        let p = [
            landmarks[i][0] as f64 - pc[0],
            landmarks[i][1] as f64 - pc[1],
        ];
        let x = [
            FACE_TEMPLATE_3D[i][0] as f64 - xc[0],
            FACE_TEMPLATE_3D[i][1] as f64 - xc[1],
            FACE_TEMPLATE_3D[i][2] as f64 - xc[2],
        ];
        for (r, &pr) in p.iter().enumerate() {
            for (c, &xc_) in x.iter().enumerate() {
                a[r][c] += pr * xc_;
            }
        }
        for r in 0..3 {
            for c in 0..3 {
                b[r][c] += x[r] * x[c];
            }
        }
    }
    // The template spans all three dimensions, so B is invertible.
    let b_inv = invert3(b).expect("canonical template is full rank");
    let mut m = [[0.0f64; 3]; 2];
    for r in 0..2 {
        for c in 0..3 {
            for (k, bi) in b_inv.iter().enumerate() {
                m[r][c] += a[r][k] * bi[c];
            }
        }
    }

    // Rows of s·R: orthonormalize symmetrically, complete with the cross
    // product for a proper rotation.
    let r1 = normalize3(m[0]);
    let r2 = normalize3(m[1]);
    let sum = normalize3([r1[0] + r2[0], r1[1] + r2[1], r1[2] + r2[2]]);
    let dif = normalize3([r1[0] - r2[0], r1[1] - r2[1], r1[2] - r2[2]]);
    let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
    let row0 = [
        (sum[0] + dif[0]) * inv_sqrt2,
        (sum[1] + dif[1]) * inv_sqrt2,
        (sum[2] + dif[2]) * inv_sqrt2,
    ];
    let row1 = [
        (sum[0] - dif[0]) * inv_sqrt2,
        (sum[1] - dif[1]) * inv_sqrt2,
        (sum[2] - dif[2]) * inv_sqrt2,
    ];
    let row2 = cross3(row0, row1);

    // R = Ry(yaw)·Rx(pitch)·Rz(roll):
    //   R[0][2] = sin(yaw)·cos(pitch)   R[2][2] = cos(yaw)·cos(pitch)
    //   R[1][2] = -sin(pitch)
    //   R[1][0] = cos(pitch)·sin(roll)  R[1][1] = cos(pitch)·cos(roll)
    let pitch = (-row1[2]).clamp(-1.0, 1.0).asin();
    let yaw = row0[2].atan2(row2[2]);
    let roll = row1[0].atan2(row1[1]);
    Pose {
        yaw: yaw.to_degrees() as f32,
        pitch: pitch.to_degrees() as f32,
        roll: roll.to_degrees() as f32,
    }
}

/// Roll directly from the eye-line angle (degrees): `atan2(right.y - left.y,
/// right.x - left.x)`, positive clockwise on screen.
pub fn roll_from_eyes(landmarks: &Landmarks) -> f32 {
    let (left, right) = eye_centers(landmarks);
    (right[1] - left[1]).atan2(right[0] - left[0]).to_degrees()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R = Ry(yaw)·Rx(pitch)·Rz(roll), angles in degrees.
    fn rotation(yaw: f64, pitch: f64, roll: f64) -> [[f64; 3]; 3] {
        let (sa, ca) = yaw.to_radians().sin_cos();
        let (sp, cp) = pitch.to_radians().sin_cos();
        let (sr, cr) = roll.to_radians().sin_cos();
        [
            [ca * cr + sa * sp * sr, -ca * sr + sa * sp * cr, sa * cp],
            [cp * sr, cp * cr, -sp],
            [-sa * cr + ca * sp * sr, sa * sr + ca * sp * cr, ca * cp],
        ]
    }

    /// Rotates the template and projects it orthographically with the given
    /// scale and translation.
    fn project(yaw: f64, pitch: f64, roll: f64, scale: f64, t: [f64; 2]) -> Landmarks {
        let r = rotation(yaw, pitch, roll);
        let mut lm = [[0.0f32; 2]; 68];
        for (i, x) in FACE_TEMPLATE_3D.iter().enumerate() {
            let x = [x[0] as f64, x[1] as f64, x[2] as f64];
            let u = r[0][0] * x[0] + r[0][1] * x[1] + r[0][2] * x[2];
            let v = r[1][0] * x[0] + r[1][1] * x[1] + r[1][2] * x[2];
            lm[i] = [(scale * u + t[0]) as f32, (scale * v + t[1]) as f32];
        }
        lm
    }

    #[test]
    fn frontal_pose_is_zero() {
        let lm = project(0.0, 0.0, 0.0, 1.5, [160.0, 120.0]);
        let pose = estimate_pose(&lm);
        assert!(pose.yaw.abs() < 0.1, "yaw {}", pose.yaw);
        assert!(pose.pitch.abs() < 0.1, "pitch {}", pose.pitch);
        assert!(pose.roll.abs() < 0.1, "roll {}", pose.roll);
    }

    /// ADR requirement: synthetic rotations within ±30° recover within ±3°.
    #[test]
    fn synthetic_rotations_recover_angles() {
        for &yaw in &[-30.0, -15.0, 0.0, 10.0, 30.0] {
            for &pitch in &[-30.0, -10.0, 0.0, 20.0, 30.0] {
                for &roll in &[-30.0, 0.0, 5.0, 30.0] {
                    let lm = project(yaw, pitch, roll, 2.0, [200.0, 150.0]);
                    let pose = estimate_pose(&lm);
                    assert!(
                        (pose.yaw as f64 - yaw).abs() < 3.0,
                        "yaw {} -> {}",
                        yaw,
                        pose.yaw
                    );
                    assert!(
                        (pose.pitch as f64 - pitch).abs() < 3.0,
                        "pitch {} -> {}",
                        pitch,
                        pose.pitch
                    );
                    assert!(
                        (pose.roll as f64 - roll).abs() < 3.0,
                        "roll {} -> {}",
                        roll,
                        pose.roll
                    );
                }
            }
        }
    }

    #[test]
    fn scale_and_translation_invariant() {
        let a = estimate_pose(&project(12.0, -8.0, 4.0, 1.0, [0.0, 0.0]));
        let b = estimate_pose(&project(12.0, -8.0, 4.0, 3.7, [500.0, 300.0]));
        assert!((a.yaw - b.yaw).abs() < 0.1);
        assert!((a.pitch - b.pitch).abs() < 0.1);
        assert!((a.roll - b.roll).abs() < 0.1);
    }

    /// ADR requirement: roll equals the eye-line angle within a degree for
    /// pure in-plane rotation.
    #[test]
    fn roll_matches_eye_line_for_in_plane_rotation() {
        for &roll in &[-25.0f64, -10.0, 0.0, 5.0, 20.0] {
            let lm = project(0.0, 0.0, roll, 1.8, [160.0, 120.0]);
            let eye_roll = roll_from_eyes(&lm) as f64;
            let pose = estimate_pose(&lm);
            assert!(
                (eye_roll - roll).abs() < 1.0,
                "eye-line roll {eye_roll} vs {roll}"
            );
            assert!(
                (pose.roll as f64 - eye_roll).abs() < 1.0,
                "fitted roll {} vs eye-line {eye_roll}",
                pose.roll
            );
        }
    }
}
