import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { localVoiceRuntimeAssets, prepareMoonshineModule } from "../scripts/local-voice-runtime-assets.js";
import runtime from "../shared/local-voice-runtime.json";

const require = createRequire(import.meta.url);
const original = (await readFile(require.resolve(`${runtime.package}/moonshine.mjs`))).toString();
const prepared = prepareMoonshineModule(Buffer.from(original)).toString();

function invokers(source: string, emvalTypes: object[] = [], allowStringCompilation = false) {
  const embind = source.slice(source.indexOf("function usesDestructorStack("),
    source.indexOf("var __embind_register_class_constructor="));
  const emval = source.slice(source.indexOf("function __emval_get_method_caller("),
    source.indexOf("function __emval_get_property("));
  assert.ok(embind && emval);
  return runInNewContext(`${embind}\n${emval}\n({ craftInvokerFunction, __emval_get_method_caller })`, {
    createNamedFunction: (name: string, fn: Function) => Object.defineProperty(fn, "name", { value: name }),
    throwBindingError: (message: string) => { throw new Error(message); },
    runDestructors: (destructors: any[]) => {
      while (destructors.length) {
        const pointer = destructors.pop();
        destructors.pop()(pointer);
      }
    },
    emval_lookupTypes: () => emvalTypes.slice(),
    emval_addMethodCaller: (fn: Function) => fn,
    emval_returnValue: (type: any, destructorsRef: number, value: unknown) => type.toWireType(destructorsRef, value),
  }, { contextCodeGeneration: { strings: allowStringCompilation, wasm: false } });
}

test("pins the native runtime to one inference thread and one helper worker", async () => {
  assert.match(prepared, /var pthreadPoolSize=1;/);
  assert.match(prepared, /MOONSHINE_ORT_SINGLE_THREAD:"1"/);
  assert.throws(() => prepareMoonshineModule(Buffer.from(`${original}\n`)), /reviewed 0.1.5/);
});

test("prepares both binding helpers for a CSP that forbids JavaScript string compilation", () => {
  assert.doesNotMatch(prepared, /new\s+Function\s*\(|\beval\s*\(/);
  const types = [{ name: "void", isVoid: true }, null];
  assert.throws(() => invokers(original).craftInvokerFunction("noop", types, null, () => {}, 1), /Code generation from strings disallowed/);
  assert.throws(() => invokers(original, [types[0]!]).__emval_get_method_caller(1, 0, 0), /Code generation from strings disallowed/);
  assert.equal(invokers(prepared).craftInvokerFunction("noop", types, null, () => 123, 1)(), undefined);
  assert.equal(invokers(prepared, [types[0]!]).__emval_get_method_caller(1, 0, 0)(null, () => 123, 0, 0), undefined);
});

test("preserves class binding, wire conversion and direct destructor order", () => {
  for (const source of [original, prepared]) {
    const calls: unknown[] = [];
    const type = (name: string) => ({
      name,
      toWireType(destructors: unknown, value: { pointer: number }) {
        assert.equal(destructors, null);
        calls.push(["wire", name, value.pointer]);
        return value.pointer;
      },
      destructorFunction(pointer: number) { calls.push(["destroy", name, pointer]); },
    });
    const types = [{ name: "result", fromWireType(value: number) { calls.push(["return", value]); return value + 1; } }, type("this"), type("argument")];
    const binding = invokers(source, [], source === original).craftInvokerFunction("method", types, {}, (...args: number[]) => {
      calls.push(["invoke", ...args]);
      return 7;
    }, 42);
    assert.equal(binding.name, "method");
    assert.equal(binding.call({ pointer: 8 }, { pointer: 9 }), 8);
    assert.deepEqual(calls, [
      ["wire", "this", 8], ["wire", "argument", 9], ["invoke", 42, 8, 9],
      ["destroy", "this", 8], ["destroy", "argument", 9], ["return", 7],
    ]);
  }
});

test("preserves stacked destructors across repeated and re-entrant native calls", () => {
  for (const source of [original, prepared]) {
    const calls: unknown[] = [];
    const argument = {
      toWireType(destructors: any[], value: number) {
        destructors.push((pointer: number) => calls.push(["destroy", pointer]), value);
        return value;
      },
    };
    let binding: Function;
    binding = invokers(source, [], source === original).craftInvokerFunction("recursive", [{ name: "void" }, null, argument, argument], null,
      (target: number, first: number, second: number) => {
        calls.push(["invoke", target, first, second]);
        if (first === 1) binding(3, 4);
      }, 42);
    binding(1, 2);
    binding(5, 6);
    assert.deepEqual(calls, [
      ["invoke", 42, 1, 2], ["invoke", 42, 3, 4], ["destroy", 4], ["destroy", 3],
      ["destroy", 2], ["destroy", 1], ["invoke", 42, 5, 6], ["destroy", 6], ["destroy", 5],
    ]);
  }
});

test("preserves packed native arguments, JavaScript receivers and return conversion", () => {
  for (const source of [original, prepared]) {
    const calls: unknown[] = [];
    const types = [
      { name: "number", toWireType(ref: number, value: number) { calls.push(["return", ref, value]); return value + 1; } },
      { name: "first", argPackAdvance: 8, readValueFromPointer(pointer: number) { calls.push(["read", pointer]); return 3; } },
      { name: "second", argPackAdvance: 4, readValueFromPointer(pointer: number) { calls.push(["read", pointer]); return 4; } },
    ];
    const binding = invokers(source, types, source === original).__emval_get_method_caller(3, 0, 0);
    const receiver = { base: 10 };
    assert.equal(binding(receiver, function (this: typeof receiver, first: number, second: number) {
      assert.equal(this, receiver);
      return this.base + first + second;
    }, 64, 100), 18);
    assert.deepEqual(calls, [["read", 100], ["read", 108], ["return", 64, 17]]);
  }
});

test("preserves JavaScript construction and skips conversion for void returns", () => {
  for (const source of [original, prepared]) {
    const types = [
      { name: "object", toWireType(_ref: number, value: unknown) { return value; } },
      { name: "number", argPackAdvance: 4, readValueFromPointer() { return 7; } },
    ];
    class Example { constructor(public value: number) {} }
    const constructor = invokers(source, types, source === original).__emval_get_method_caller(2, 0, 1);
    const value = constructor(null, Example, 0, 0);
    assert.ok(value instanceof Example);
    assert.equal(value.value, 7);
    const voidType = { name: "void", isVoid: true, toWireType() { assert.fail("void return must not be converted"); } };
    const method = invokers(source, [voidType, types[1]], source === original).__emval_get_method_caller(2, 0, 0);
    let called = false;
    assert.equal(method(null, (argument: number) => { assert.equal(argument, 7); called = true; return 123; }, 0, 0), undefined);
    assert.equal(called, true);
  }
});

test("emits a complete same-origin SDK including its module worker and Wasm", async () => {
  const plugin = localVoiceRuntimeAssets();
  const generated = new Map<string, Uint8Array>();
  const hook = plugin.generateBundle as Function;
  await hook.call({ emitFile(asset: { fileName: string; source: Uint8Array }) { generated.set(asset.fileName, asset.source); } });
  for (const name of ["index.js", "module.js", "transcriber.js", "stream.js", "moonshine.mjs", "moonshine.wasm"]) {
    assert.ok(generated.has(`${runtime.basePath.slice(1)}${name}`), name);
  }
  for (const name of generated.keys()) assert.match(name, /^vendor\/moonshine\/0\.1\.5-ceres1\/[a-z0-9-]+\.(js|mjs|wasm)$/);
});
