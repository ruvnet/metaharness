import Mathlib

theorem fib_add_four_recurrence_nat (n : ℕ) : Nat.fib (n + 4) + Nat.fib n = 3 * Nat.fib (n + 2) := by
  simp only [Nat.fib_add_two]
  ring
