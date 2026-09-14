import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel, rustAdapter, javaAdapter, csharpAdapter, rubyAdapter } from "@brewdocs/core";

function tmpPkg(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewdocs-lang-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

const RUST = `//! Crate docs.

use std::fmt;

/// Greet someone by name.
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

/// Adds numbers.
pub fn add(
    a: i64,
    b: i64,
) -> i64 {
    a + b
}

/// A point in 2D space.
pub struct Point {
    /// The X coordinate.
    pub x: f64,
    pub y: f64,
}

impl Point {
    /// Origin point.
    pub fn origin() -> Point {
        Point { x: 0.0, y: 0.0 }
    }

    pub fn scale(&mut self, k: f64) {
        self.x *= k;
    }
}

/// A direction.
pub enum Direction {
    /// Up.
    Up,
    /// Down.
    Down(u8),
}

/// Something summable.
pub trait Summable {
    /// The sum.
    fn sum(&self) -> f64;
}

pub type Meters = f64;

pub const MAX: usize = 10;

#[deprecated(note = "use greet")]
pub fn hello(name: &str) -> String {
    greet(name)
}
`;

describe("v3.0 Rust extractor", () => {
  it("extracts functions, impl methods, structs, enums, traits, types and consts", () => {
    const root = tmpPkg({ "Cargo.toml": "[package]\nname = \"pt\"\n", "src/lib.rs": RUST });
    const model = buildModel({ root });
    const byName = new Map(model.symbols.map((s) => [s.name, s]));
    const names = [...byName.keys()];

    expect(names).toContain("greet");
    expect(names).toContain("add");
    expect(names).toContain("Point");
    expect(names).toContain("Point::origin");
    expect(names).toContain("Point::scale");
    expect(names).toContain("Direction");
    expect(names).toContain("Summable");
    expect(names).toContain("Meters");
    expect(names).toContain("MAX");
    expect(names).toContain("hello");
    expect(names).not.toContain("fmt");

    const greet = byName.get("greet")!;
    expect(greet.kind).toBe("function");
    expect(greet.description).toBe("Greet someone by name.");
    expect(greet.params).toEqual([{ name: "name", type: "&str" }]);
    expect(greet.returns?.type).toBe("String");

    // wrapped multi-line signature
    expect(byName.get("add")!.params.map((p) => p.name)).toEqual(["a", "b"]);

    const point = byName.get("Point")!;
    expect(point.kind).toBe("class");
    expect(point.members?.map((m) => m.name)).toEqual(["x", "y"]);
    expect(point.members?.[0].description).toBe("The X coordinate.");

    // self is dropped from documented params
    expect(byName.get("Point::scale")!.params).toEqual([{ name: "k", type: "f64" }]);

    const dir = byName.get("Direction")!;
    expect(dir.members?.map((m) => m.name)).toEqual(["Up", "Down"]);
    expect(dir.members?.find((m) => m.name === "Down")?.type).toBe("u8");

    expect(byName.get("Summable")!.kind).toBe("interface");
    expect(byName.get("Summable")!.members?.[0].name).toBe("sum");
    expect(byName.get("Meters")!.kind).toBe("type");
    expect(byName.get("MAX")!.kind).toBe("constant");
    expect(byName.get("hello")!.deprecated).toBe("use greet");
  });

  it("detects cargo projects only", () => {
    expect(rustAdapter.detect({ root: tmpPkg({ "Cargo.toml": "" }), metadata: {} })).toBe(true);
    expect(
      rustAdapter.detect({ root: tmpPkg({ "src/main.rs": "fn main() {}" }), metadata: {} }),
    ).toBe(true);
    expect(rustAdapter.detect({ root: tmpPkg({ "a.ts": "" }), metadata: {} })).toBe(false);
  });
});

const JAVA = `package com.acme.util;

import java.util.List;

/**
 * A tiny counter.
 *
 * @see Math
 */
public class Counter {
    /** Current value. */
    private int value;

    public static final int MAX = 100;

    /** Creates a counter. */
    public Counter() {
    }

    /**
     * Adds n.
     *
     * @param n how much
     * @return the new value
     * @throws IllegalStateException on overflow
     */
    public int add(int n) throws IllegalStateException {
        value += n;
        return value;
    }

    public void reset() {
    }
}

/** A shape. */
public interface Shape {
    /** Area. */
    double area();
}

/** Directions. */
public enum Color {
    RED,
    GREEN,
    BLUE;

    /** Name lowercase. */
    public String lower() {
        return name().toLowerCase();
    }
}

/** A point. */
public record Point(int x, int y) {
}
`;

describe("v3.0 Java extractor", () => {
  it("extracts classes, javadoc, methods, enum constants, interfaces and records", () => {
    const root = tmpPkg({ "src/main/java/com/acme/util/Counter.java": JAVA });
    const model = buildModel({ root });
    const byName = new Map(model.symbols.map((s) => [s.name, s]));

    const counter = byName.get("Counter")!;
    expect(counter.kind).toBe("class");
    expect(counter.description).toBe("A tiny counter.");
    expect(counter.see).toEqual(["Math"]);
    expect(counter.members?.map((m) => m.name)).toContain("MAX");
    expect(counter.members?.map((m) => m.name)).toContain("Counter");
    expect(counter.members?.find((m) => m.name === "MAX")).toMatchObject({
      kind: "property",
      readonly: true,
      static: true,
    });
    expect(counter.members?.find((m) => m.kind === "constructor")).toBeTruthy();

    const add = byName.get("Counter.add")!;
    expect(add.kind).toBe("function");
    expect(add.description).toBe("Adds n.");
    expect(add.params).toEqual([
      { name: "n", type: "int", description: "how much" },
    ]);
    expect(add.returns).toEqual({ type: "int", description: "the new value" });
    expect(add.throws).toEqual(["IllegalStateException on overflow"]);

    expect(byName.get("Counter.reset")!.returns).toBeUndefined();

    const shape = byName.get("Shape")!;
    expect(shape.kind).toBe("interface");
    expect(byName.get("Shape.area")!.kind).toBe("function");

    const color = byName.get("Color")!;
    expect(color.members?.map((m) => m.name)).toEqual(["RED", "GREEN", "BLUE"]);
    expect(byName.get("Color.lower")!.description).toBe("Name lowercase.");

    expect(byName.get("Point")!.kind).toBe("class");
    expect(byName.get("Point")!.description).toBe("A point.");
  });

  it("detects maven/gradle/java sources, not JS", () => {
    expect(javaAdapter.detect({ root: tmpPkg({ "pom.xml": "<project/>" }), metadata: {} })).toBe(true);
    expect(
      javaAdapter.detect({ root: tmpPkg({ "src/A.java": "public class A {}" }), metadata: {} }),
    ).toBe(true);
    expect(javaAdapter.detect({ root: tmpPkg({ "a.ts": "" }), metadata: {} })).toBe(false);
  });
});

const CSHARP = `using System;

/// <summary>A widget factory.</summary>
public class Widget
{
    /// <summary>The widget label.</summary>
    public string Label { get; set; }

    /// <summary>Number of parts.</summary>
    public int Count { get; }

    /// <summary>
    /// Builds a widget.
    /// </summary>
    /// <param name="name">The name.</param>
    /// <param name="parts">How many parts.</param>
    /// <returns>A new widget.</returns>
    /// <exception cref="T:System.ArgumentError">bad name</exception>
    public static Widget Create(string name, int parts = 0)
    {
        return new Widget();
    }

    public Widget()
    {
    }
}

/// <summary>Things that render.</summary>
public interface IRenderer
{
    /// <summary>Renders once.</summary>
    void Render();
}

/// <summary>Legacy helpers.</summary>
public static class Legacy
{
    [Obsolete("use Widget.Create")]
    public static void Make(string name) { }
}
`;

describe("v3.0 C# extractor", () => {
  it("extracts classes, XML docs, properties, methods and [Obsolete]", () => {
    const root = tmpPkg({ "Lib.csproj": "<Project/>", "src/Widget.cs": CSHARP });
    const model = buildModel({ root });
    const byName = new Map(model.symbols.map((s) => [s.name, s]));

    const widget = byName.get("Widget")!;
    expect(widget.kind).toBe("class");
    expect(widget.description).toBe("A widget factory.");
    const label = widget.members?.find((m) => m.name === "Label");
    expect(label).toMatchObject({ kind: "property", type: "string" });
    const count = widget.members?.find((m) => m.name === "Count");
    expect(count?.readonly).toBe(true);
    expect(widget.members?.find((m) => m.kind === "constructor")).toBeTruthy();

    const create = byName.get("Widget.Create")!;
    expect(create.kind).toBe("function");
    expect(create.description).toBe("Builds a widget.");
    expect(create.params).toEqual([
      { name: "name", type: "string", description: "The name.", optional: undefined, default: undefined },
      { name: "parts", type: "int", description: "How many parts.", optional: true, default: "0" },
    ]);
    expect(create.returns).toEqual({ type: "Widget", description: "A new widget." });
    expect(create.throws?.[0]).toContain("ArgumentError");

    expect(byName.get("IRenderer")!.kind).toBe("interface");
    expect(byName.get("IRenderer")!.description).toBe("Things that render.");

    expect(byName.get("Legacy.Make")!.deprecated).toBe("use Widget.Create");
  });

  it("detects csproj and .cs files, not JS", () => {
    expect(csharpAdapter.detect({ root: tmpPkg({ "App.csproj": "<Project/>" }), metadata: {} })).toBe(true);
    expect(csharpAdapter.detect({ root: tmpPkg({ "A.cs": "public class A { }" }), metadata: {} })).toBe(true);
    expect(csharpAdapter.detect({ root: tmpPkg({ "a.ts": "" }), metadata: {} })).toBe(false);
  });
});

const RUBY = `# A friendly greeter.
class Greeter
  attr_accessor :name, :greeting

  # Initialize the greeter.
  #
  # @param name [String] the greetee
  def initialize(name)
    @name = name
  end

  # Say hello.
  #
  # @param loud [Boolean] shout it
  # @return [String] the greeting
  # @raise [ArgumentError] if name is nil
  # @deprecated use #shout
  def hello(loud = false)
    return "HI" if loud
    @name
  end

  # Shout it.
  def self.shout(name)
    name.upcase
  end

  private

  # Internal helper.
  def helper
    42
  end
end

# Top-level helper.
#
# @param x [Integer] input
# @return [Integer] doubled
def double(x)
  x * 2
end

MAX_LIFE = 42
`;

describe("v3.0 Ruby extractor", () => {
  it("extracts classes, methods, accessors, YARD tags and visibility", () => {
    const root = tmpPkg({ "lib/greeter.rb": RUBY });
    const model = buildModel({ root });
    const byName = new Map(model.symbols.map((s) => [s.name, s]));

    const greeter = byName.get("Greeter")!;
    expect(greeter.kind).toBe("class");
    expect(greeter.description).toBe("A friendly greeter.");
    expect(greeter.members?.map((m) => m.name)).toEqual(["name", "greeting", "Greeter"]);

    const hello = byName.get("Greeter#hello")!;
    expect(hello.kind).toBe("function");
    expect(hello.description).toBe("Say hello.");
    expect(hello.params).toEqual([
      { name: "loud", type: "Boolean", description: "shout it", optional: true, default: "false" },
    ]);
    expect(hello.returns).toEqual({ type: "String", description: "the greeting" });
    expect(hello.throws).toEqual(["ArgumentError — if name is nil"]);
    expect(hello.deprecated).toBe("use #shout");

    expect(byName.get("Greeter.shout")!.kind).toBe("function");
    expect(byName.get("Greeter#helper")).toBeUndefined();
    expect(byName.get("double")!.params).toEqual([
      { name: "x", type: "Integer", description: "input" },
    ]);
    expect(byName.get("double")!.returns).toEqual({ type: "Integer", description: "doubled" });
    expect(byName.get("MAX_LIFE")!.kind).toBe("constant");
  });

  it("detects gemspecs and .rb files, not JS", () => {
    expect(rubyAdapter.detect({ root: tmpPkg({ "x.gemspec": "" }), metadata: {} })).toBe(true);
    expect(rubyAdapter.detect({ root: tmpPkg({ "lib/a.rb": "def a; end" }), metadata: {} })).toBe(true);
    expect(rubyAdapter.detect({ root: tmpPkg({ "a.ts": "" }), metadata: {} })).toBe(false);
  });
});
