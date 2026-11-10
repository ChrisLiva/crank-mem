// Adds two numbers.
function add(a, b) {
  return a + b;
}

function* count(n) {
  for (let i = 0; i < n; i++) yield i;
}

class Counter {
  total = 0;
  bump = (by) => {
    this.total += by;
  };
  reset() {
    this.total = 0;
  }
}

const f = () => {
  return 1;
};

/** Gets. */
var g = function () {
  return 2;
};

export default function () {
  return 3;
}

export class Store {
  get(key) {
    return key;
  }
}

const App = () => <div/>;

export default class {}

const o = { m() {} };
[1, 2].forEach(function each(x) {
  return x;
});
function outer() {
  function inner() {}
  return inner;
}
const n = 1;
