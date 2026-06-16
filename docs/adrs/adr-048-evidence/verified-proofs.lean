import Mathlib

-- Open d1 goal: six-dvd-pow-three-add-five-mul-s1
theorem two_dvd_pow_three_add_five_mul (n : ℤ) : (2 : ℤ) ∣ n ^ 3 + 5 * n := by
  rcases Int.even_or_odd n with ⟨k, rfl⟩ | ⟨k, rfl⟩
  · exact ⟨4 * k ^ 3 + 5 * k, by ring⟩
  · exact ⟨4 * k ^ 3 + 6 * k ^ 2 + 8 * k + 3, by ring⟩

-- Open d1 goal: dvd-210-pow-fifteen-sub-pow-three-s1
theorem dvd_2_pow_fifteen_sub_pow_three (n : ℤ) : (2 : ℤ) ∣ n ^ 15 - n ^ 3 := by
  have key : ∀ x : ZMod 2, x ^ 15 - x ^ 3 = 0 := by decide
  have h : ((n ^ 15 - n ^ 3 : ℤ) : ZMod 2) = 0 := by push_cast; exact key _
  exact_mod_cast (ZMod.intCast_zmod_eq_zero_iff_dvd (n ^ 15 - n ^ 3) 2).mp h
