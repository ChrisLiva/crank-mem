// @ts-nocheck
import { readFileSync } from "node:fs";
const n = 1;

/** Adds two numbers. */
export function add(a: number, b: number): number {
  function inner() {}
  return a + b;
}

function* count(): Generator<number> {
  yield 1;
}

function over(a: string): string;
function over(a: number): number;
function over(a: unknown): unknown {
  return a;
}

export const twice = (x: number) => x * 2;

var legacy = function (y: string) {
  return y;
};

const obj = {
  method() {
    return 1;
  },
};

[1].forEach(() => {
  function inner() {}
});

function decorate(target: unknown, key: string) {}

export class Box<T> {
  size = 1;
  handler = () => {
    return this.size;
  };
  late = function () {
    return 2;
  };
  constructor(private value: T) {}
  @decorate
  get current(): T {
    return this.value;
  }
}

export abstract class Shape {
  abstract area(): number;
  describe(): string {
    return "shape";
  }
}

export interface Named {
  name: string;
  greet(
    other: Named,
  ): string;
}

export type Pair = [string, number];

export enum Color {
  Red,
  Green,
}

namespace NS {
  export function helper(): void {}
}

declare module "m" {
  export function fromM(): void;
}

export default function () {
  return readFileSync.length + n + obj.method();
}
