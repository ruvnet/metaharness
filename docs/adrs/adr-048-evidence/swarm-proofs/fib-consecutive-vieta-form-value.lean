import Mathlib

theorem fib_consecutive_vieta_form_value (n : ℕ) : (Nat.fib (n+1) : ℤ)^2 - (Nat.fib (n+1)) * (Nat.fib n) - (Nat.fib n)^2 = (-1)^n := by
  induction n with
  | zero => simp
  | succ k ih =>
    have hrec : Nat.fib (k + 2) = Nat.fib k + Nat.fib (k + 1) := Nat.fib_add_two
    have hcast : (Nat.fib (k + 2) : ℤ) = (Nat.fib k : ℤ) + (Nat.fib (k + 1) : ℤ) := by
      exact_mod_cast hrec
    rw [hcast, pow_succ]
    linear_combination -ih