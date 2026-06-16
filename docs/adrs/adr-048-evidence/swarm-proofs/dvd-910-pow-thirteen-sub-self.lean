import Mathlib

set_option maxRecDepth 20000 in
theorem dvd_910_pow_thirteen_sub_self (n : ℤ) : (910 : ℤ) ∣ n ^ 13 - n := by
  have h : (910 : ℤ) = 2 * 5 * 7 * 13 := by norm_num
  rw [h]
  have key : ∀ (m : ℕ), 0 < m → (∀ a : ZMod m, a ^ 13 = a) → (m : ℤ) ∣ n ^ 13 - n := by
    intro m hm hcast
    have : ((n ^ 13 - n : ℤ) : ZMod m) = 0 := by
      push_cast
      rw [hcast]
      ring
    exact (ZMod.intCast_zmod_eq_zero_iff_dvd _ _).mp this
  have h2 : (2 : ℤ) ∣ n ^ 13 - n := key 2 (by norm_num) (by decide)
  have h5 : (5 : ℤ) ∣ n ^ 13 - n := key 5 (by norm_num) (by decide)
  have h7 : (7 : ℤ) ∣ n ^ 13 - n := key 7 (by norm_num) (by decide)
  have h13 : (13 : ℤ) ∣ n ^ 13 - n := key 13 (by norm_num) (by decide)
  have c25 : IsCoprime (2 : ℤ) 5 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have c357 : IsCoprime (2 * 5 : ℤ) 7 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have c13 : IsCoprime (2 * 5 * 7 : ℤ) 13 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have d10 : (2 * 5 : ℤ) ∣ n ^ 13 - n := c25.mul_dvd h2 h5
  have d70 : (2 * 5 * 7 : ℤ) ∣ n ^ 13 - n := c357.mul_dvd d10 h7
  exact c13.mul_dvd d70 h13