import Mathlib

theorem alt_sum_range_two_k_add_one_eq_signed_n (n : ℕ) : ∑ k ∈ Finset.range n, (-1 : ℤ) ^ k * (2 * (k : ℤ) + 1) = (-1) ^ (n + 1) * (n : ℤ) := by
  induction n with
  | zero => simp
  | succ m ih =>
    rw [Finset.sum_range_succ, ih]
    push_cast
    rw [pow_succ, pow_succ]
    ring
