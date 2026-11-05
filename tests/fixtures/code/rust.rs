use std::fmt::{self, Display};

/// Adds one.
#[inline]
pub fn add_one(x: u32) -> u32 {
    let inner = |y: u32| y + 1;
    fn helper() {}
    helper();
    inner(x)
}

pub struct Foo {
    x: u32,
}

struct Pair(u32, u32);

union Bits {
    i: u32,
    f: f32,
}

enum Color {
    Red,
    Green,
}

pub trait Shape {
    fn area(&self) -> f64;
    fn name(&self) -> String {
        String::new()
    }
}

impl Foo {
    pub fn new() -> Self {
        Foo { x: 0 }
    }
}

struct Gen<T>(T);

impl<T> Gen<T> {
    fn get(&self) -> &T {
        &self.0
    }
}

impl Display for Foo {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.x)
    }
}

mod inner {
    fn f() {}
}

mod decl;

type Alias = u8;

const C: u8 = 1;
static S: u8 = 2;
