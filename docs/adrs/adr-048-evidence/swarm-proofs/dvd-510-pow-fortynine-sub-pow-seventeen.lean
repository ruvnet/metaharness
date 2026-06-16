import Mathlib

theorem dvd_510_pow_fortynine_sub_pow_seventeen (n : ℤ) :
    (510 : ℤ) ∣ n ^ 49 - n ^ 17 := by
  set x : ℤ := n ^ 49 - n ^ 17 with hx
  have key : ∀ (p : ℕ), p = 2 ∨ p = 3 ∨ p = 5 ∨ p = 17 → (p : ℤ) ∣ x := by
    intro p hp
    have h : ((x : ℤ) : ZMod p) = 0 := by
      rw [hx]; push_cast
      rcases hp with rfl | rfl | rfl | rfl
      · have : ∀ m : ZMod 2, m ^ 49 - m ^ 17 = 0 := by decide
        exact this _
      · have : ∀ m : ZMod 3, m ^ 49 - m ^ 17 = 0 := by decide
        exact this _
      · have : ∀ m : ZMod 5, m ^ 49 - m ^ 17 = 0 := by decide
        exact this _
      · have : ∀ m : ZMod 17, m ^ 49 - m ^ 17 = 0 := by decide
        exact this _
    have := (ZMod.intCast_zmod_eq_zero_iff_dvd x p).mp h
    exact_mod_cast this
  have h2 : (2 : ℤ) ∣ x := by have := key 2 (by tauto); exact_mod_cast this
  have h3 : (3 : ℤ) ∣ x := by have := key 3 (by tauto); exact_mod_cast this
  have h5 : (5 : ℤ) ∣ x := by have := key 5 (by tauto); exact_mod_cast this
  have h17 : (17 : ℤ) ∣ x := by have := key 17 (by tauto); exact_mod_cast this
  have c23 : IsCoprime (2 : ℤ) 3 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have h6 : (6 : ℤ) ∣ x := by
    have : (2 * 3 : ℤ) ∣ x := c23.mul_dvd h2 h3
    simpa using this
  have c65 : IsCoprime (6 : ℤ) 5 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have h30 : (30 : ℤ) ∣ x := by
    have : (6 * 5 : ℤ) ∣ x := c65.mul_dvd h6 h5
    simpa using this
  have c3017 : IsCoprime (30 : ℤ) 17 := by
    rw [Int.isCoprime_iff_gcd_eq_one]; decide
  have h510 : (510 : ℤ) ∣ x := by
    have : (30 * 17 : ℤ) ∣ x := c3017.mul_dvd h30 h17
    simpa using this
  exact h510