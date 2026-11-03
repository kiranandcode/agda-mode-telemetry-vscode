module Test where

data Nat : Set where
  zero : Nat
  suc  : Nat → Nat

-- a comment with {! not a goal !}
add : Nat → Nat → Nat
add x y = ?

one : Nat
one = ?
