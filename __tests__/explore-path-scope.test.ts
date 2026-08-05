import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore indexed path scope', () => {
  let root = '';
  let cg: CodeGraph | null = null;

  afterEach(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps same-named symbols inside an explicitly named directory', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-path-scope-'));
    fs.mkdirSync(path.join(root, 'tools/dedalo'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tools/dedalo/campaign.py'),
      'def dedalo_helper():\n    return 1\n\ndef runCampaign():\n    return dedalo_helper()\n',
    );
    fs.writeFileSync(
      path.join(root, 'src/runtime/campaign.py'),
      'def runtime_helper():\n    return 2\n\ndef runCampaign():\n    return runtime_helper()\n',
    );
    cg = CodeGraph.initSync(root);
    await cg.indexAll();

    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'tools/dedalo runCampaign',
    });
    const output = result.content[0]!.text as string;
    expect(output).toContain('Indexed scope: tools/dedalo');
    expect(output).toContain('dedalo_helper');
    expect(output).not.toContain('runtime_helper');
    expect(output).not.toContain('src/runtime/campaign.py');
  });
});
