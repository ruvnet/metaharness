import Mathlib

theorem fib_add_five_eq_five_mul_fib_succ_add_three_mul_fib (n : ℕ) : Nat.fib (n + 5) = 5 * Nat.fib (n + 1) + 3 * Nat.fib n := by
  simp only [Nat.fib_add_two]
  ring