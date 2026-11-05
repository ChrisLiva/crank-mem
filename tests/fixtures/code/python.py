import functools


# Caches results.
@functools.cache
def fib(n):
    def helper(k):
        return k
    return n if n < 2 else fib(n - 1) + fib(n - 2)


class Shape:
    """A docstring, not a comment."""

    sides = 0

    def area(self, scale):
        return 0

    @property
    def name(self):
        return "shape"


async def fetch(url):
    return url


def one(): pass


type Alias = int

f = lambda x: x
