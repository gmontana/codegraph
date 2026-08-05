/**
 * Zig build graph synthesis.
 *
 * A literal `b.path("src/root.zig")` is a build-time dependency on that source
 * file. Zig does not express it with `@import`, so the normal resolver cannot
 * see it. This pass emits only literal, project-root-relative paths that name
 * an indexed Zig file; dynamic paths remain absent rather than guessed.
 */
import * as path from 'path';
import type { Edge } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';

const BUILD_FILE = /^(?:build\.zig|build\/.*\.zig)$/;
const SOURCE_PATH = /\b\w+\.path\s*\(\s*"([^"\n]+\.zig)"\s*\)/g;

/** Return dependency edges proven by literal Zig build paths. */
export async function zigBuildEdges(
  ctx: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const buildPath of ctx.getAllFiles()) {
    if ((++scanned & 15) === 0) await onYield();
    if (!BUILD_FILE.test(buildPath)) continue;
    const content = ctx.readFile(buildPath);
    const source = ctx.getNodesInFile(buildPath).find((node) => node.kind === 'file');
    if (!content || !source) continue;

    SOURCE_PATH.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SOURCE_PATH.exec(content)) !== null) {
      const targetPath = path.posix.normalize(match[1]!);
      if (targetPath.startsWith('../') || path.posix.isAbsolute(targetPath)) continue;
      const target = ctx.getNodesInFile(targetPath).find((node) => node.kind === 'file');
      if (!target || seen.has(`${source.id}>${target.id}`)) continue;
      seen.add(`${source.id}>${target.id}`);
      edges.push({
        source: source.id,
        target: target.id,
        kind: 'imports',
        line: content.slice(0, match.index).split('\n').length,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'zig-build-path', path: targetPath },
      });
    }
  }
  return edges;
}
