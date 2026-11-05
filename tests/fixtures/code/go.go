package shapes

// Add returns the sum.
func Add(a, b int) int {
	return a + b
}

func Map[T any](xs []T, f func(T) T) []T {
	inc := func(x int) int { return x + 1 }
	_ = inc
	return xs
}

type Foo struct {
	x int
}

func (f Foo) Len() int {
	return f.x
}

type G2[T any] struct {
	v T
}

func (s *G2[T]) M() {
}

type Shape interface {
	Area() float64
}

type ID int

type A = int

type (
	B struct{ x int }
	C int
)

var v = 1

const k = 2
