import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_546_pow_fourteen_sub_sq (n : ℤ) : (546 : ℤ) ∣ n ^ 14 - n ^ 2 := by
  have key : ∀ x : ZMod 546, x ^ 14 - x ^ 2 = 0 := by decide
  have : ((546 : ℕ) : ℤ) ∣ n ^ 14 - n ^ 2 := by
    rw [← ZMod.intCast_zmod_eq_zero_iff_dvd]
    push_cast
    exact key _
  simpa using this