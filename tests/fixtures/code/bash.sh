#!/usr/bin/env bash
X=1

f() {
  echo f
}

function g {
  echo g
}

# Says h.
function h() {
  echo h
}

s() (
  cd /tmp
)

outer() { inner() { :; }; }
