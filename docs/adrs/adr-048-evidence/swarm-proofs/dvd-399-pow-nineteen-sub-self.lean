import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_399_pow_nineteen_sub_self (n : ℤ) : (399 : ℤ) ∣ n ^ 19 - n := by
  have key : ((n ^ 19 - n : ℤ) : ZMod 399) = 0 := by
    push_cast
    have : ∀ x : ZMod 399, x ^ 19 - x = 0 := by decide
    exact this _
  exact (ZMod.intCast_zmod_eq_zero_iff_dvd _ 399).mp key