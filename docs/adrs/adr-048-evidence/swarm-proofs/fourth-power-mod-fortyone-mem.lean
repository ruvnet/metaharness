import Mathlib

theorem fourth_power_mod_fortyone_mem (r : ℕ) (hr : r < 41) : (∃ n : ℕ, n ^ 4 % 41 = r) ↔ r ∈ ({0, 1, 4, 10, 16, 18, 23, 25, 31, 37, 40} : Finset ℕ) := by
  constructor
  · rintro ⟨n, rfl⟩
    have h : n ^ 4 % 41 = (n % 41) ^ 4 % 41 := by
      rw [Nat.pow_mod]
    rw [h]
    have hlt : n % 41 < 41 := Nat.mod_lt _ (by norm_num)
    interval_cases (n % 41) <;> decide
  · intro hr2
    fin_cases hr2
    · exact ⟨0, by decide⟩
    · exact ⟨1, by decide⟩
    · exact ⟨11, by decide⟩
    · exact ⟨4, by decide⟩
    · exact ⟨2, by decide⟩
    · exact ⟨16, by decide⟩
    · exact ⟨7, by decide⟩
    · exact ⟨6, by decide⟩
    · exact ⟨12, by decide⟩
    · exact ⟨8, by decide⟩
    · exact ⟨3, by decide⟩