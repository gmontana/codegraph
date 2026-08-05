/**
 * Zig Extraction Tests
 *
 * Zig has no classes — types are values bound to a const (`const X = struct{}`)
 * and modules are `const m = @import(...)`. These tests pin the idioms the
 * extractor must get right: container types, scope-based methods, fields, enum
 * members, constants, imports, test blocks, and the import-namespace mappings
 * that make cross-file `callers`/`callees` resolve.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import type { ExtractionResult } from '../src/types';
import { extractFromSource } from '../src/extraction';
import {
  detectLanguage,
  isLanguageSupported,
  getSupportedLanguages,
  initGrammars,
  loadAllGrammars,
} from '../src/extraction/grammars';
import { extractImportMappings } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const SAMPLE = `
const std = @import("std");
const helper = @import("./util/helper.zig");

pub const max_items: u32 = 8;

pub const Color = enum { red, green, blue };
pub const Choice = union(enum) { item: u8, none };
pub const Handle = opaque {};
pub const Failure = error{ Missing, Invalid };
const private_limit: u32 = 4;

pub const Point = struct {
    x: f32,
    y: f32,

    pub fn add(self: Point, other: Point) Point {
        return .{ .x = self.x + other.x, .y = self.y + other.y };
    }
};

pub fn translate(p: Point) Point {
    const callback = Point.add;
    var scratch: usize = 0;
    _ = callback;
    _ = scratch;
    return helper.shift(p);
}

test "point add" {
    _ = Point.add;
}
`;

describe('Zig language wiring', () => {
  it('detects .zig as zig and reports it supported', () => {
    expect(detectLanguage('src/main.zig')).toBe('zig');
    expect(isLanguageSupported('zig')).toBe(true);
    expect(getSupportedLanguages()).toContain('zig');
  });
});

describe('Zig extraction', () => {
  // Computed in beforeAll, not at collection time — the file-level beforeAll
  // must load the grammar first.
  let result: ExtractionResult;
  beforeAll(() => {
    result = extractFromSource('shapes.zig', SAMPLE, 'zig');
  });

  const byKind = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);

  it('extracts a const-bound struct as a struct, not a constant', () => {
    expect(byKind('struct', 'Point')).toBeDefined();
    expect(byKind('constant', 'Point')).toBeUndefined();
  });

  it('extracts a struct method as a method (scope-based, no receiver syntax)', () => {
    const add = byKind('method', 'add');
    expect(add).toBeDefined();
    expect(add!.qualifiedName).toContain('Point');
  });

  it('extracts struct fields', () => {
    expect(byKind('field', 'x')).toBeDefined();
    expect(byKind('field', 'y')).toBeDefined();
  });

  it('extracts a const-bound enum and its members', () => {
    expect(byKind('enum', 'Color')).toBeDefined();
    expect(byKind('enum_member', 'red')).toBeDefined();
    expect(byKind('enum_member', 'blue')).toBeDefined();
  });

  it('extracts union and opaque containers and error sets', () => {
    expect(byKind('struct', 'Choice')).toBeDefined();
    expect(byKind('field', 'item')).toBeDefined();
    expect(byKind('struct', 'Handle')).toBeDefined();
    expect(byKind('enum', 'Failure')).toBeDefined();
    expect(byKind('enum_member', 'Missing')).toBeDefined();
    expect(byKind('enum_member', 'Invalid')).toBeDefined();
  });

  it('extracts a top-level fn as a function and a plain const as a constant', () => {
    expect(byKind('function', 'translate')).toBeDefined();
    expect(byKind('constant', 'max_items')).toBeDefined();
  });

  it('records public visibility and excludes function locals', () => {
    expect(byKind('constant', 'max_items')?.visibility).toBe('public');
    expect(byKind('constant', 'private_limit')?.visibility).toBe('private');
    expect(result.nodes.some((n) => n.name === 'callback')).toBe(false);
    expect(result.nodes.some((n) => n.name === 'scratch')).toBe(false);
  });

  it('extracts @import as import nodes', () => {
    expect(byKind('import', 'std')).toBeDefined();
    expect(byKind('import', './util/helper.zig')).toBeDefined();
  });

  it('extracts a test block as a callable function node', () => {
    expect(byKind('function', 'point add')).toBeDefined();
  });

  it('emits a calls reference for a namespaced member call', () => {
    // `helper.shift(p)` — the dotted ref the resolver maps through the import.
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'helper.shift' && r.referenceKind === 'calls'
    );
    expect(ref).toBeDefined();
  });

  it('emits a function reference for a stored method value', () => {
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'add' && r.referenceKind === 'function_ref'
    );
    expect(ref).toBeDefined();
  });

});

describe('Zig comptime dispatch references', () => {
  const DISPATCH = `
fn fast() void {}
fn slow() void {}

const routes = [_]*const fn () void{
    fast,
    slow,
};
`;

  it('links functions stored in a file-scope dispatch table', () => {
    const result = extractFromSource('dispatch.zig', DISPATCH, 'zig');
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'function_ref')
      .map((r) => r.referenceName);
    expect(refs).toContain('fast');
    expect(refs).toContain('slow');
  });
});

describe('Zig import mappings (cross-file resolution)', () => {
  it('maps @import bindings to namespace imports', () => {
    const maps = extractImportMappings('shapes.zig', SAMPLE, 'zig');
    const helper = maps.find((m) => m.localName === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.source).toBe('./util/helper.zig');
    expect(helper!.isNamespace).toBe(true);
    expect(maps.find((m) => m.localName === 'std')).toBeDefined();
  });

  it('accepts bare relative file paths and multiline declarations', () => {
    const maps = extractImportMappings(
      'main.zig',
      'pub const widget = @import(\n    "util/widget.zig"\n);',
      'zig'
    );
    expect(maps).toEqual([
      {
        localName: 'widget',
        exportedName: '*',
        source: 'util/widget.zig',
        isDefault: false,
        isNamespace: true,
      },
    ]);
  });

  it('maps a member selected directly from an imported file', () => {
    expect(extractImportMappings(
      'main.zig',
      'const Engine = @import("engine.zig").Engine;',
      'zig'
    )).toEqual([{
      localName: 'Engine',
      exportedName: 'Engine',
      source: 'engine.zig',
      isDefault: false,
      isNamespace: false,
    }]);
  });

  it('propagates top-level import aliases but ignores function locals', () => {
    expect(extractImportMappings('main.zig', `
const zing = @import("zing");
const compiler = zing.compiler;
const semantic = compiler.semantic;
fn local() void { const fake = zing.fake; _ = fake; }
`, 'zig')).toEqual([
      {
        localName: 'zing', exportedName: '*', source: 'zing',
        isDefault: false, isNamespace: true,
      },
      {
        localName: 'compiler', exportedName: 'compiler', source: 'zing',
        isDefault: false, isNamespace: false,
      },
      {
        localName: 'semantic', exportedName: 'compiler.semantic', source: 'zing',
        isDefault: false, isNamespace: false,
      },
    ]);
  });
});

describe('Zig generic-type factories', () => {
  // `fn List(T) type { return struct {...} }` — Zig's generic types are
  // functions returning an anonymous container.
  const FACTORY = `
pub fn List(comptime T: type) type {
    return struct {
        items: []T,
        pub fn append(self: *@This(), x: T) void { _ = self; _ = x; }
        pub fn clear(self: *@This()) void { _ = self; }
    };
}`;
  let nodes: { kind: string; name: string; qualifiedName?: string }[];
  beforeAll(() => {
    nodes = extractFromSource('list.zig', FACTORY, 'zig').nodes;
  });

  it('indexes the factory as a struct named for the function', () => {
    expect(nodes.find((n) => n.kind === 'struct' && n.name === 'List')).toEqual(
      expect.objectContaining({ typeParameters: ['T'] })
    );
  });

  it('indexes the returned container declarations as methods of that type', () => {
    const append = nodes.find((n) => n.kind === 'method' && n.name === 'append');
    expect(append).toBeDefined();
    expect(append!.qualifiedName).toContain('List');
    expect(nodes.find((n) => n.kind === 'method' && n.name === 'clear')).toBeDefined();
    expect(nodes.find((n) => n.kind === 'field' && n.name === 'items')).toBeDefined();
  });

  it('indexes a returned enum as an enum with members', () => {
    const enumNodes = extractFromSource(
      'tag.zig',
      'pub fn Tag(comptime T: type) type { _ = T; return enum { one, two }; }',
      'zig'
    ).nodes;
    expect(enumNodes.find((n) => n.kind === 'enum' && n.name === 'Tag')).toBeDefined();
    expect(enumNodes.find((n) => n.kind === 'enum_member' && n.name === 'two')).toBeDefined();
  });

  it('does not emit factory type parameters as project dependencies', () => {
    const result = extractFromSource('list.zig', FACTORY, 'zig');
    expect(result.unresolvedReferences.some(
      (ref) => ref.referenceKind === 'references' && ref.referenceName === 'T'
    )).toBe(false);
  });

  it('does not emit generic parameters used by typed locals as dependencies', () => {
    const result = extractFromSource('generic.zig', `
fn use(comptime T: type, value: T) void {
    const copy: T = value;
    _ = copy;
}
`, 'zig');
    expect(result.nodes.find((node) => node.name === 'use')?.typeParameters).toEqual(['T']);
    expect(result.unresolvedReferences.some(
      (ref) => ref.referenceKind === 'references' && ref.referenceName === 'T'
    )).toBe(false);
  });
});

describe('Zig systems-code semantics', () => {
  it('recognizes Zig package manifests', () => {
    expect(detectLanguage('build.zig.zon')).toBe('zig');
  });

  it('records precise field, local, parameter, and return type dependencies', () => {
    const result = extractFromSource('types.zig', `
const Node = struct {
    next: ?*Node,
    child: pkg.Child,
    storage: [count]Element,
    aligned: [*:0]align(boundary) const Payload,
};
fn convert(comptime T: type, node: *const Node) Error!pkg.Result {
    const local: Local = undefined;
    _ = T;
    _ = node;
    _ = local;
}
`, 'zig');
    const refs = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'references')
      .map((ref) => ref.referenceName);

    expect(refs).toEqual(expect.arrayContaining([
      'Node', 'pkg.Child', 'Element', 'Payload', 'Error', 'pkg.Result', 'Local',
    ]));
    expect(refs).not.toEqual(expect.arrayContaining(['count', 'boundary', 'T', 'u8']));
  });

  it('keeps complete namespace calls and recognizes @call', () => {
    const result = extractFromSource('calls.zig', `
fn target() void {}
fn run() void {
    std.debug.print("ok", .{});
    _ = @call(.auto, target, .{});
}
`, 'zig');
    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);

    expect(calls).toContain('std.debug.print');
    expect(calls).toContain('target');
  });

  it('retains inline @import member types and calls for exact resolution', () => {
    const result = extractFromSource('inline_import.zig', `
fn run(value: @import("types.zig").Value) void {
    @import("worker.zig").execute(value);
}
`, 'zig');
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'references',
      referenceName: '@import("types.zig").Value',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'calls',
      referenceName: '@import("worker.zig").execute',
    }));
  });

  it('tracks typed initializers as instantiations', () => {
    const result = extractFromSource(
      'init.zig',
      'const Point = struct { x: f64 }; fn make() Point { return Point{ .x = 1 }; }',
      'zig'
    );
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'instantiates',
      referenceName: 'Point',
    }));
  });

  it('indexes C headers from @cImport without a synthetic c module', () => {
    const result = extractFromSource('ffi.zig', `
const c = @cImport({
    @cInclude("stdio.h");
    // @cInclude("not-real.h");
    @cInclude("sys/types.h");
});
`, 'zig');
    const imports = result.nodes.filter((node) => node.kind === 'import').map((node) => node.name);
    expect(imports.sort()).toEqual(['stdio.h', 'sys/types.h']);
  });

  it('retains tagged-union payload fields and also indexes their tags', () => {
    const result = extractFromSource(
      'value.zig',
      'const Value = union(enum) { integer: i64, text: []const u8, _ };',
      'zig'
    );
    const value = result.nodes.find((node) => node.kind === 'struct' && node.name === 'Value');
    expect(value?.decorators).toContain('tagged_union');
    expect(result.nodes.some((node) => node.kind === 'field' && node.name === 'integer')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'integer')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === '_')).toBe(false);
  });

  it('preserves ABI and optimization modifiers without changing source visibility', () => {
    const result = extractFromSource('abi.zig', `
inline fn fast() void {}
noinline fn slow() void {}
export fn callback(ctx: *anyopaque) callconv(.C) void { _ = ctx; }
`, 'zig');
    const fast = result.nodes.find((node) => node.name === 'fast');
    const slow = result.nodes.find((node) => node.name === 'slow');
    const callback = result.nodes.find((node) => node.name === 'callback');

    expect(fast?.decorators).toContain('inline');
    expect(slow?.decorators).toContain('noinline');
    expect(callback?.signature).toContain('callconv(.C)');
    expect(callback?.isExported).toBe(true);
    expect(callback?.visibility).toBe('private');
  });
});

describe('Zig resolved project graph', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves a namespaced call through a relative @import', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-import-'));
    fs.writeFileSync(
      path.join(tempDir, 'util.zig'),
      'pub fn shift(value: i32) i32 { return value + 1; }\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.zig'),
      'const util = @import("util.zig");\npub fn run() i32 { return util.shift(41); }\n'
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      const shift = cg.getNodesByName('shift').find((n) => n.kind === 'function');
      expect(shift).toBeDefined();
      expect(cg.getCallers(shift!.id).map((c) => c.node.name)).toContain('run');
    } finally {
      cg.destroy();
    }
  });

  it('links functions stored in a comptime dispatch table', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-dispatch-'));
    fs.writeFileSync(
      path.join(tempDir, 'dispatch.zig'),
      [
        'fn fast() void {}',
        'fn slow() void {}',
        'const routes = [_]*const fn () void{ fast, slow };',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      for (const name of ['fast', 'slow']) {
        const fn = cg.getNodesByName(name).find((n) => n.kind === 'function');
        expect(fn).toBeDefined();
        expect(
          cg.getIncomingEdges(fn!.id).some(
            (edge) => edge.kind === 'references' && edge.metadata?.fnRef === true
          )
        ).toBe(true);
      }
    } finally {
      cg.destroy();
    }
  });

  it('resolves selected imports, inline imports, and typed receiver methods', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-semantics-'));
    fs.writeFileSync(
      path.join(tempDir, 'engine.zig'),
      [
        'pub const Engine = struct {',
        '    pub fn run(self: Engine) void { _ = self; }',
        '};',
        'pub fn Builder(comptime capacity: usize) type {',
        '    _ = capacity;',
        '    return struct { pub fn emit(self: @This()) void { _ = self; } };',
        '}',
        'pub fn execute() void {}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.zig'),
      [
        'const Engine = @import("engine.zig").Engine;',
        'const Builder = @import("engine.zig").Builder;',
        'pub fn drive(engine: Engine) void {',
        '    engine.run();',
        '    const builder = Builder(8){};',
        '    builder.emit();',
        '    @import("engine.zig").execute();',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      const run = cg.getNodesByName('run').find((node) => node.kind === 'method');
      const execute = cg.getNodesByName('execute').find((node) => node.kind === 'function');
      const emit = cg.getNodesByName('emit').find((node) => node.kind === 'method');
      expect(run).toBeDefined();
      expect(execute).toBeDefined();
      expect(emit).toBeDefined();
      expect(cg.getCallers(run!.id).map((caller) => caller.node.name)).toContain('drive');
      expect(cg.getCallers(execute!.id).map((caller) => caller.node.name)).toContain('drive');
      expect(cg.getCallers(emit!.id).map((caller) => caller.node.name)).toContain('drive');
    } finally {
      cg.destroy();
    }
  });

  it('resolves project modules declared by build.zig', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-module-'));
    fs.writeFileSync(
      path.join(tempDir, 'build.zig'),
      'const modules = @import("build/modules.zig");\npub fn build(b: *std.Build) void { _ = modules; _ = b.addModule("app", .{ .root_source_file = b.path("root.zig") }); }\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'root.zig'),
      'pub const compiler = @import("compiler.zig");\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'compiler.zig'),
      'pub fn execute() void {}\npub fn work() void {}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.zig'),
      'const app = @import("app");\nconst compiler = app.compiler;\npub fn run() void { compiler.execute(); @import("worker").work(); }\n'
    );
    fs.mkdirSync(path.join(tempDir, 'build'));
    fs.writeFileSync(
      path.join(tempDir, 'build', 'modules.zig'),
      [
        'const worker_module = b.createModule(.{ .root_source_file = b.path("compiler.zig") });',
        'exe.root_module.addImport("worker", worker_module);',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      const execute = cg.getNodesByName('execute').find((node) => node.kind === 'function');
      const work = cg.getNodesByName('work').find((node) => node.kind === 'function');
      expect(execute).toBeDefined();
      expect(work).toBeDefined();
      expect(cg.getCallers(execute!.id).map((caller) => caller.node.name)).toContain('run');
      expect(cg.getCallers(work!.id).map((caller) => caller.node.name)).toContain('run');
    } finally {
      cg.destroy();
    }
  });

  it('links literal Zig build paths to their source files', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-build-path-'));
    fs.mkdirSync(path.join(tempDir, 'tools', 'dedalo'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'build.zig'),
      'pub fn add(b: *std.Build) void { _ = b.path("tools/dedalo/promotion_schema.zig"); }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'tools', 'dedalo', 'promotion_schema.zig'),
      '//! Design: owns the promotion schema.\n//! Invariants: versions only increase.\npub const schema_version = 1;\n',
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      expect(cg.getFileDependencies('build.zig')).toContain(
        'tools/dedalo/promotion_schema.zig',
      );
      expect(cg.getFileDependents('tools/dedalo/promotion_schema.zig')).toContain(
        'build.zig',
      );
      const result = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'tools/dedalo schema_version',
      });
      const output = result.content[0]!.text as string;
      expect(output).toContain('Change capsule — ownership and contracts');
      expect(output).toContain('invariants: versions only increase.');
      expect(output).toContain('build: build.zig');
    } finally {
      cg.destroy();
    }
  });

  it('resolves imported receiver types through re-exports without same-name collisions', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-receiver-'));
    fs.writeFileSync(
      path.join(tempDir, 'good.zig'),
      'pub const Context = struct { pub fn init() Context { return .{}; } pub fn execute(self: *Context) void { _ = self; } };\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'wrong.zig'),
      'pub const Context = struct { pub fn execute(self: *Context) void { _ = self; } };\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'api.zig'),
      'const implementation = @import("good.zig");\npub const Context = implementation.Context;\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.zig'),
      'const api = @import("api.zig");\nconst Context = api.Context;\npub fn drive(ctx: *Context) void { ctx.execute(); }\npub fn construct() void { var ctx = api.Context.init(); ctx.execute(); }\n'
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      const methods = cg.getNodesByName('execute').filter((node) => node.kind === 'method');
      const good = methods.find((node) => node.filePath === 'good.zig');
      const wrong = methods.find((node) => node.filePath === 'wrong.zig');
      expect(good).toBeDefined();
      expect(wrong).toBeDefined();
      expect(cg.getCallers(good!.id).map((caller) => caller.node.name)).toEqual(
        expect.arrayContaining(['drive', 'construct'])
      );
      const wrongCallers = cg.getCallers(wrong!.id).map((caller) => caller.node.name);
      expect(wrongCallers).not.toContain('drive');
      expect(wrongCallers).not.toContain('construct');
    } finally {
      cg.destroy();
    }
  });
});
