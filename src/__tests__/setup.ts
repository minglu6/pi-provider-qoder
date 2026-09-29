import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

// Set this before provider modules load: static model definitions also resolve CN routing.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = mkdtempSync(join(tmpdir(), "qoder-tests-"));
process.env.PI_CODING_AGENT_DIR = root;

beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "case-"));
});

afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
});
