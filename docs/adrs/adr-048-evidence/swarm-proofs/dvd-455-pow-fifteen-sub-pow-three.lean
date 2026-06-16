import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_455_pow_fifteen_sub_pow_three (n : ℤ) : (455 : ℤ) ∣ n ^ 15 - n ^ 3 := by
  have h : ((455 : ℤ) : ZMod 455) = 0 := by decide
  suffices hh : ((n ^ 15 - n ^ 3 : ℤ) : ZMod 455) = 0 by
    rwa [ZMod.intCast_zmod_eq_zero_iff_dvd] at hh
  push_cast
  generalize (n : ZMod 455) = x
  revert x
  decide