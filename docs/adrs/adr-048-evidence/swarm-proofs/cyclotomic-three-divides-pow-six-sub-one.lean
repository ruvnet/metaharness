import Mathlib

theorem cyclotomic_three_divides_pow_six_sub_one (n : ℤ) : (n ^ 2 + n + 1) ∣ (n ^ 6 - 1) := by
  exact ⟨n ^ 4 - n ^ 3 + n - 1, by ring⟩
