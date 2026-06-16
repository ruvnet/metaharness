import Mathlib

theorem cyclic_cube_sum_ge_asym_quad_cubic (a b c : ℝ)
    (ha : 0 ≤ a) (hb : 0 ≤ b) (hc : 0 ≤ c) :
    a^2 * b + b^2 * c + c^2 * a ≤ a^3 + b^3 + c^3 := by
  nlinarith [sq_nonneg (a - b), sq_nonneg (b - c), sq_nonneg (c - a),
             mul_nonneg ha (sq_nonneg (a - b)), mul_nonneg hb (sq_nonneg (b - c)),
             mul_nonneg hc (sq_nonneg (c - a)), mul_nonneg hb (sq_nonneg (a - b)),
             mul_nonneg hc (sq_nonneg (b - c)), mul_nonneg ha (sq_nonneg (c - a)),
             mul_nonneg ha hb, mul_nonneg hb hc, mul_nonneg hc ha]