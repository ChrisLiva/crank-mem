#include <cstddef>
#define SQUARE(x) ((x) * (x))

// Adds two numbers.
int add(int a, int b) {
  auto twice = [](int v) { return v * 2; };
  return twice(a) + b;
}

int proto(int a);

int (*fp)(int);
class Fwd;
struct B { int y; } b;

int* make() { return nullptr; }

using Id = int;
typedef int Handle;
typedef struct { int z; } Z;

template <typename T> T maxOf(T a, T b) { return a > b ? a : b; }

template <typename T>
class Holder {
  T value;
  T get() const { return value; }
};

extern "C" {
int c_fn(void) { return 0; }
}

namespace A {
  namespace B {
    class Foo {
    public:
      Foo();
      ~Foo();
      void inline_def() {}
      void outside();
      virtual void g() = 0;
      bool operator==(const Foo&) const;
      operator bool() const { return true; }
      Foo& get();
      int x;
    };

    namespace { void hidden() {} }

    struct Point {
      int px;
      int len() const { return px; }
    };

    union Value {
      int i;
      float f;
    };

    enum Color { Red, Green };
    enum class Mode { On, Off };
  }
}

void A::B::Foo::outside() {}
A::B::Foo::~Foo() {}
A::B::Foo& A::B::Foo::get() { return *this; }

#ifdef FEATURE
int feature() { return 1; }
#else
int feature() { return 0; }
#endif

#if 1
void when_on() {}
#endif

#ifndef GUARD
void guarded() {}
#endif

namespace GUI {
  class HoverLabel {
    void SetTitle() {
    }
  };

  class ExtruderGroup {
    void SetTitle();
  };

  void ExtruderGroup::SetTitle() {
  }
}
