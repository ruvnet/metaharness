import Mathlib

theorem dvd_twentyfour_pow_seven_sub_pow_five (n : ℤ) : (24 : ℤ) ∣ n ^ 7 - n ^ 5 := by
  have h : ((n ^ 7 - n ^ 5 : ℤ) : ZMod 24) = 0 := by
    push_cast
    have : ∀ m : ZMod 24, m ^ 7 - m ^ 5 = 0 := by decide
    exact this (n : ZMod 24)
  have := (ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 7 - n ^ 5) 24).mp
  exact_mod_cast this (by exact_mod_cast h)