import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_273_pow_fourteen_sub_sq (n : ℤ) : (273 : ℤ) ∣ n ^ 14 - n ^ 2 := by
  have key : ∀ m : ZMod 273, m ^ 14 - m ^ 2 = 0 := by decide
  have h := (ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 14 - n ^ 2) 273).mp
  apply h
  push_cast
  simpa using key (n : ZMod 273)