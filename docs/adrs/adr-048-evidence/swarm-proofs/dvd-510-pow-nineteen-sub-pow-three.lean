import Mathlib

theorem dvd_510_pow_nineteen_sub_pow_three (n : ℤ) :
    (510 : ℤ) ∣ (n ^ 19 - n ^ 3) := by
  have h : ((n ^ 19 - n ^ 3 : ℤ) : ZMod 510) = 0 := by
    push_cast
    have : ∀ x : ZMod 510, x ^ 19 - x ^ 3 = 0 := by
      set_option maxRecDepth 10000 in decide
    simpa using this (n : ZMod 510)
  rwa [ZMod.intCast_zmod_eq_zero_iff_dvd] at h