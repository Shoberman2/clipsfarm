import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const json = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

test("renamed npm package metadata keeps the former executable alias", () => {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  assert.equal(pkg.name, "clipsfarm");
  assert.equal(pkg.bin.clipsfarm, "dist/cli.js");
  assert.equal(pkg.bin.clipswarm, pkg.bin.clipsfarm);
  assert.equal(pkg.mcpName, "io.github.Shoberman2/clipsfarm");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.deepEqual(lock.packages[""].bin, pkg.bin);
});

test("MCP registry and Claude plugin identities use the new name", () => {
  const registry = json("server.json");
  const marketplace = json(".claude-plugin/marketplace.json");
  const plugin = json("plugins/clipsfarm/.claude-plugin/plugin.json");
  assert.equal(registry.name, "io.github.Shoberman2/clipsfarm");
  assert.equal(registry.packages[0].identifier, "clipsfarm");
  assert.equal(marketplace.name, "clipsfarm");
  assert.equal(marketplace.plugins[0].name, "clipsfarm");
  assert.equal(marketplace.plugins[0].source, "./plugins/clipsfarm");
  assert.equal(plugin.name, "clipsfarm");
});
