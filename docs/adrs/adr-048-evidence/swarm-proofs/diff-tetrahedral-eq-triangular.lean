import Mathlib

theorem diff_tetrahedral_eq_triangular (n : ℕ) : (n + 1) * (n + 2) * (n + 3) / 6 - n * (n + 1) * (n + 2) / 6 = (n + 1) * (n + 2) / 2 := by
  have six : ∀ a : ℕ, 6 ∣ a * (a + 1) * (a + 2) := by
    intro a
    have h1 : a.ascFactorial 3 = a * (a + 1) * (a + 2) := by
      simp [Nat.ascFactorial]; ring
    have h2 : 6 ∣ a.ascFactorial 3 := by
      have := Nat.factorial_dvd_ascFactorial a 3
      simpa [Nat.factorial] using this
    rwa [h1] at h2
  have two : ∀ a : ℕ, 2 ∣ a * (a + 1) := by
    intro a
    rcases Nat.even_or_odd a with he | ho
    · obtain ⟨m, rfl⟩ := he
      exact ⟨(m + m) * m + m, by ring⟩
    · obtain ⟨m, rfl⟩ := ho
      exact ⟨(2 * m + 1) * (m + 1), by ring⟩
  -- tetrahedral for (n+1) consecutive starting at n+1
  have d6a : 6 ∣ (n + 1) * (n + 2) * (n + 3) := by
    have := six (n + 1)
    have e : (n + 1) * (n + 1 + 1) * (n + 1 + 2) = (n + 1) * (n + 2) * (n + 3) := by ring
    rwa [e] at this
  have d6b : 6 ∣ n * (n + 1) * (n + 2) := six n
  have d2 : 2 ∣ (n + 1) * (n + 2) := by
    have := two (n + 1)
    have e : (n + 1) * (n + 1 + 1) = (n + 1) * (n + 2) := by ring
    rwa [e] at this
  obtain ⟨x, hx⟩ := d6a
  obtain ⟨y, hy⟩ := d6b
  obtain ⟨z, hz⟩ := d2
  rw [hx, hy, hz]
  rw [Nat.mul_div_cancel_left _ (by norm_num : (0:ℕ) < 6),
      Nat.mul_div_cancel_left _ (by norm_num : (0:ℕ) < 6),
      Nat.mul_div_cancel_left _ (by norm_num : (0:ℕ) < 2)]
  -- now need x - y = z, where 6x = (n+1)(n+2)(n+3), 6y = n(n+1)(n+2), 2z = (n+1)(n+2)
  -- relation: (n+1)(n+2)(n+3) = n(n+1)(n+2) + 3(n+1)(n+2)
  have rel : (n + 1) * (n + 2) * (n + 3) = n * (n + 1) * (n + 2) + 3 * ((n + 1) * (n + 2)) := by ring
  -- substitute
  rw [hx, hy, hz] at rel
  -- 6x = 6y + 3*(2z) = 6y + 6z  => x = y + z
  omega