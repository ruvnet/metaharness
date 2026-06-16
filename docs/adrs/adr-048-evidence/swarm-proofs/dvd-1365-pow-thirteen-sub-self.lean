import Mathlib

set_option maxRecDepth 20000 in
theorem dvd_1365_pow_thirteen_sub_self (n : ℤ) : (1365 : ℤ) ∣ n ^ 13 - n := by
  have h := (ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 13 - n) 1365).mp
  apply h
  push_cast
  have : ∀ x : ZMod 1365, x ^ 13 - x = 0 := by decide
  exact this _