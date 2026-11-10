import * as React from "react";

const n = 1;

export function Card(props: { title: string }): JSX.Element {
  function inner() {}
  return <div className="card">{props.title}</div>;
}

function* ids(): Generator<number> {
  yield n;
}

function pick(a: string): string;
function pick(a: unknown): unknown {
  return a;
}

export const Badge = ({ label }: { label: string }) => <span>{label}</span>;

var Legacy = function () {
  return <p>old</p>;
};

const handlers = {
  onClick() {
    return null;
  },
};

[1].forEach(() => {
  function inner() {}
});

function track(target: unknown, key: string) {}

class Panel extends React.Component<{ open: boolean }> {
  count = 0;
  toggle = () => {
    return <button>toggle</button>;
  };
  format = function (v: number) {
    return String(v);
  };
  @track
  render() {
    return <section>{this.props.open ? "open" : "shut"}</section>;
  }
}

abstract class Base {
  protected abstract draw(): JSX.Element;
}

interface Props {
  title: string;
  onSelect(id: number): void;
}

type Size = "s" | "m";

enum Tone {
  Light,
}

namespace UI {
  export function frame(): JSX.Element {
    return <main />;
  }
}

declare module "m" {
  export function fromM(): void;
}

export default function () {
  return <Card title={String(handlers.onClick())} />;
}

export default class {
  show() {
    return <Badge label="x" />;
  }
}
