import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_266_pow_nineteen_sub_self (n : ℤ) : (266 : ℤ) ∣ n ^ 19 - n := by
  have key : ∀ m : ZMod 266, m ^ 19 - m = 0 := by decide
  have := (ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 19 - n) 266).mp
  apply this
  push_cast
  exact key _