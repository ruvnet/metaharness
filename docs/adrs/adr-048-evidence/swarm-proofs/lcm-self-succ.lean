import Mathlib

theorem lcm_self_succ (n : ℕ) : Nat.lcm n (n + 1) = n * (n + 1) := by
  have h : Nat.Coprime n (n + 1) := by
    simpa using Nat.coprime_succ_self_right (n := n)
  exact h.lcm_eq_mul