import Mathlib

theorem cyclotomic_five_divides_pow_five_sub_one (n : ℤ) : (n ^ 4 + n ^ 3 + n ^ 2 + n + 1) ∣ (n ^ 5 - 1) := by
  exact ⟨n - 1, by ring⟩
