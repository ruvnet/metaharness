import Mathlib

theorem fib_add_six_eq_eight_mul_fib_succ_add_five_mul_fib (n : ℕ) : Nat.fib (n + 6) = 8 * Nat.fib (n + 1) + 5 * Nat.fib n := by
  simp only [Nat.fib_add_two]
  ring