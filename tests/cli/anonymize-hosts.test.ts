// --anonymize hashes URL, ssh and git hosts and owner/repo; purge --all removes the hook log and rules caches only.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataFiles } from "../../src/cli/main.ts";
import { anonymizer } from "../../src/cli/wrapped.ts";

const base = mkdtempSync(join(tmpdir(), "rh-anon-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("hosts, remotes and domains are hashed; loopback stays", () => {
  const fix = anonymizer([], []);
  const out = fix("curl https://api.corp-client.example.invalid:8443/x; git clone git@github.com:acme-co/secret-repo.git; " +
    "git remote add o https://github.com/acme-co/secret-repo; ssh -p 22 deploy@build.corp-client.test; rsync -a . bob@192.0.2.7:/srv; curl http://localhost:3000/a");
  for (const leak of ["corp-client", "acme-co", "secret-repo", "github.com", "deploy@", "bob@", "192.0.2.7"]) expect(out).not.toContain(leak);
  expect(out).toContain("localhost:3000/a");
  expect(out).toContain(":8443/x");
  expect(fix("https://github.com/acme-co/secret-repo")).toBe(fix("https://github.com/acme-co/secret-repo"));
  expect(fix.host("evil.corp-client.test")).not.toContain("corp-client");
});

test("purge --all file list: log and caches only, no symlinks", () => {
  const dir = join(base, "home", ".retrohound");
  mkdirSync(dir, { recursive: true });
  for (const n of ["hook-log.jsonl", "rules-cache-abc123.json", "keep.txt", "index.db"]) writeFileSync(join(dir, n), "x");
  writeFileSync(join(base, "outside"), "x");
  symlinkSync(join(base, "outside"), join(dir, "rules-cache-dead01.json"));
  expect(dataFiles(dir).map((p) => p.split("/").pop()).sort()).toEqual(["hook-log.jsonl", "rules-cache-abc123.json"]);
  expect(existsSync(join(base, "outside"))).toBe(true);
});
