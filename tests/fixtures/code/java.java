package shapes;

/** A box. */
@Deprecated
public class Box {
    private int size = 1;

    static {
        System.out.println("init");
    }

    public Box(int size) {
        this.size = size;
    }

    public int area() {
        Runnable r = new Runnable() {
            public void run() {}
        };
        Runnable l = () -> {};
        return size * size;
    }
}

record Point(int x, int y) {}

interface Shape {
    double area();
}

@interface Marker {
    String value() default "";
}

enum Color {
    RED, GREEN;

    int code() {
        return ordinal();
    }
}
