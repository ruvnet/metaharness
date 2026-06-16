import Mathlib

theorem dvd_twentyfour_pow_six_sub_pow_four (n : ℤ) : (24 : ℤ) ∣ n ^ 6 - n ^ 4 := by
  have h : ((n ^ 6 - n ^ 4 : ℤ) : ZMod 24) = 0 := by
    push_cast
    generalize (n : ZMod 24) = m
    revert m
    decide
  exact (ZMod.intCast_zmod_eq_zero_iff_dvd _ 24).mp h