import Mathlib

theorem fib_add_three_eq_two_mul_fib_succ_add_fib (n : ℕ) : Nat.fib (n + 3) = 2 * Nat.fib (n + 1) + Nat.fib n := by
  rw [Nat.fib_add_two, Nat.fib_add_two]
  ring