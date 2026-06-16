import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_133_pow_nineteen_sub_self (n : ℤ) : (133 : ℤ) ∣ n ^ 19 - n := by
  have key : ∀ x : ZMod 133, x ^ 19 - x = 0 := by decide
  have h : ((n ^ 19 - n : ℤ) : ZMod 133) = 0 := by
    push_cast
    exact key (n : ZMod 133)
  rwa [ZMod.intCast_zmod_eq_zero_iff_dvd] at h