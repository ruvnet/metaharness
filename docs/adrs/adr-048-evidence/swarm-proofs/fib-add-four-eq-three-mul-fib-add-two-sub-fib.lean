import Mathlib

theorem fib_add_four_eq_three_mul_fib_add_two_sub_fib (n : ℕ) : Nat.fib (n + 4) = 3 * Nat.fib (n + 2) - Nat.fib n := by
  simp only [Nat.fib_add_two]
  omega
