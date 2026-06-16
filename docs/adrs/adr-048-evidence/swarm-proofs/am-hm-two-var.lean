import Mathlib

theorem am_hm_two_var (a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 4 / (a + b) ≤ 1 / a + 1 / b := by
  rw [div_add_div _ _ (ne_of_gt ha) (ne_of_gt hb), div_le_div_iff₀ (by positivity) (by positivity)]
  nlinarith [sq_nonneg (a - b), mul_pos ha hb]