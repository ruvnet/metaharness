import Mathlib

theorem catalan_r2_int_fib (n : ℤ) : Int.fib n ^ 2 - Int.fib (n - 2) * Int.fib (n + 2) = (-1) ^ n.natAbs := by
  have h := Int.fib_add_sq_sub_fib_mul_fib_add_two_mul (n - 2) 2
  simp only [sub_add_cancel, show (n - 2) + 2 * 2 = n + 2 by ring, Int.fib_two, one_pow, mul_one] at h
  rw [h]
  -- goal: (-1) ^ (n - 2).natAbs = (-1) ^ n.natAbs
  have hpar : Even (n - 2).natAbs ↔ Even n.natAbs := by
    rw [Int.natAbs_even, Int.natAbs_even, Int.even_sub]
    simp [Int.even_iff]  -- 2 is even
  rcases Nat.even_or_odd n.natAbs with he | ho
  · rw [he.neg_one_pow, (hpar.mpr he).neg_one_pow]
  · have ho2 : Odd (n - 2).natAbs := by
      rcases Nat.even_or_odd (n - 2).natAbs with h2 | h2
      · exact absurd (hpar.mp h2) (by simpa [Nat.not_even_iff_odd] using ho)
      · exact h2
    rw [ho.neg_one_pow, ho2.neg_one_pow]