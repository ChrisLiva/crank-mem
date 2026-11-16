def top
end

module Shapes
  class Box
    attr_reader :a

    # Area of the box.
    def area(w, h)
      def inner
      end
      sq = ->(x) { x * x }
      w * h
    end

    def self.cm
      new
    end

    private def pm; end

    class << self
      def build
        new
      end
    end
  end
end

def sq(x) = x * x

def m; end

def drive(box)
  top()
  self.m
  box.area(1, 2)
  Shapes::Box.new
  puts "done"
end
