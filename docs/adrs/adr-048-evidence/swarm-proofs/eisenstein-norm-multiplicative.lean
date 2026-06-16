import Mathlib

theorem eisenstein_norm_multiplicative (a b c d : ℤ)
    (m n : ℤ) (hm : m = a^2 + a*b + b^2) (hn : n = c^2 + c*d + d^2) :
    ∃ x y : ℤ, m * n = x^2 + x*y + y^2 := by
  refine ⟨a*c - b*d, a*d + b*c + b*d, ?_⟩
  subst hm hn
  ring