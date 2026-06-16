import Mathlib

theorem alt_sum_range_sq_eq_signed_pronic (n : ℕ) : 2 * ∑ k ∈ Finset.range (n + 1), (-1 : ℤ) ^ k * (k : ℤ) ^ 2 = (-1 : ℤ) ^ n * ((n : ℤ) * ((n : ℤ) + 1)) := by
  induction n with
  | zero => simp
  | succ m ih =>
    rw [Finset.sum_range_succ, mul_add, ih]
    push_cast
    ring