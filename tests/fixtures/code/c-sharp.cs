namespace App;

/// <summary>A foo.</summary>
[Serializable]
public class Foo
{
    private int count = 1;
    public int Size { get; set; }
    public event EventHandler Changed;

    public Foo(int count)
    {
        this.count = count;
    }

    ~Foo()
    {
    }

    public static Foo operator +(Foo a, Foo b) => a;

    public int this[int i] => i;

    public int Area()
    {
        int Square(int x) { return x * x; }
        return Square(count);
    }
}

public record Point(int X, int Y);

public struct Pair
{
    public int Left;
}

public interface IShape
{
    double Area();
}

public enum Color
{
    Red,
    Green,
}

public delegate void Handler(int code);

public class Driver
{
    public void Run(Foo foo)
    {
        Helper();
        this.Helper();
        foo.Area();
        var f = new Foo(1);
        Foo g = new(2);
    }
}
