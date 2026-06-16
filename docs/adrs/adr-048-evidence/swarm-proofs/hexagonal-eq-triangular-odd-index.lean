import Mathlib

theorem hexagonal_eq_triangular_odd_index (n : ℕ) : n * (2 * n - 1) = (2 * n - 1) * (2 * n) / 2 := by
  rcases n with _ | m
  · simp
  · have h : (2 * (m + 1) - 1) * (2 * (m + 1)) = 2 * ((m + 1) * (2 * (m + 1) - 1)) := by
      have : 2 * (m + 1) - 1 = 2 * m + 1 := by omega
      rw [this]; ring
    rw [h, Nat.mul_div_cancel_left _ (by norm_num)]