<?php

namespace App\Models;

function helper(int $x): int
{
    $double = function ($y) {
        return $y * 2;
    };
    return $double($x);
}

/** A user. */
#[Entity]
class User
{
    public const TABLE = 'users';
    private string $name = '';

    public function name(): string
    {
        $anon = new class {
            public function hidden() {}
        };
        return $this->name;
    }
}

interface HasName
{
    public function name(): string;
}

trait Greets
{
    public function greet(): string
    {
        return 'hi';
    }
}

enum Suit: string
{
    case Hearts = 'H';

    public function label(): string
    {
        return 'x';
    }
}

namespace Other {
    class Inner {
        function f() {}
    }
}
