import Mathlib

set_option maxRecDepth 8000 in
theorem dvd_273_pow_thirteen_sub_self (n : ℤ) : (273 : ℤ) ∣ n ^ 13 - n := by
  have key : ∀ x : ZMod 273, x ^ 13 - x = 0 := by decide
  have h : ((n : ZMod 273) ^ 13 - (n : ZMod 273) = 0) ↔ ((273 : ℤ) ∣ n ^ 13 - n) := by
    have := ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 13 - n) 273
    push_cast at this
    convert this using 2
  rw [← h]
  exact key _