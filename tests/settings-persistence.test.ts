import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldSettings, writeDebugSnapshot } from "../src/core/settings";

let tmp: string;
let config: string;
let previous: string | undefined;
const read = (path = config) => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-vcc-settings-"));
  config = join(tmp, "vcc.json");
  previous = process.env.PI_VCC_CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = config;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = previous;
  rmSync(tmp, { recursive: true, force: true });
});

describe("scaffoldSettings", () => {
  test("creates settings once and leaves complete files unchanged", () => {
    scaffoldSettings();
    expect(read()).toEqual({ overrideDefaultCompaction: true, debug: false });
    const before = statSync(config);
    scaffoldSettings();
    expect(statSync(config).ino).toBe(before.ino);
    expect(readdirSync(tmp)).toEqual(["vcc.json"]);
  });

  test.each(["{ partial", "null", "[]", '{"debug":"false"}'])("leaves malformed settings %s alone", (content) => {
    writeFileSync(config, content);
    scaffoldSettings();
    expect(readFileSync(config, "utf8")).toBe(content);
    expect(readdirSync(tmp)).toEqual(["vcc.json"]);
  });

  test("fills missing defaults via symlink without truncating the previous inode", () => {
    const target = join(tmp, "shared.json");
    const before = '{"debug":true,"custom":42}';
    writeFileSync(target, before, { mode: 0o640 });
    symlinkSync("shared.json", config);
    const fd = openSync(target, "r");
    try {
      scaffoldSettings();
      expect(readFileSync(fd, "utf8")).toBe(before);
      expect(lstatSync(config).isSymbolicLink()).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(read(target)).toEqual({ debug: true, custom: 42, overrideDefaultCompaction: true });
    } finally {
      closeSync(fd);
    }
  });

  test("does not publish over a competing writer, then fills defaults against its new data", async () => {
    const staged = join(tmp, "other-write.json");
    writeFileSync(staged, '{"overrideDefaultCompaction":false,"keep":true}');
    writeFileSync(config, '{"debug":true}');
    const child = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      const [config, temp] = process.argv.slice(1);
      fs.mkdirSync(config + '.lock');
      process.stdout.write('locked\\n');
      fs.readSync(0, Buffer.alloc(1));
      fs.renameSync(temp, config);
      fs.rmdirSync(config + '.lock');
    `, config, staged], { timeout: 4000, stdio: ["pipe", "pipe", "inherit"] });
    const closed = once(child, "close");
    try {
      expect(await Promise.race([
        once(child.stdout, "data").then(([data]) => data.toString()),
        closed.then(() => "closed before acquiring lock"),
      ])).toBe("locked\n");
      scaffoldSettings();
      expect(read()).toEqual({ debug: true });
      expect(existsSync(`${config}.lock`)).toBe(true);
    } finally {
      child.stdin.end();
      expect(await closed).toEqual([0, null]);
    }
    scaffoldSettings();
    expect(read()).toEqual({ overrideDefaultCompaction: false, keep: true, debug: false });
  });
});

describe("writeDebugSnapshot", () => {
  test("publishes complete private snapshots scoped to the active config", () => {
    writeDebugSnapshot({ generation: 1 });
    const path = `${config}.debug.json`;
    const fd = openSync(path, "r");
    try {
      writeDebugSnapshot({ generation: 2 });
      expect(JSON.parse(readFileSync(fd, "utf8"))).toEqual({ generation: 1 });
      expect(read(path)).toEqual({ generation: 2 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(config)).toBe(false);
      expect(readdirSync(tmp)).toEqual(["vcc.json.debug.json"]);
    } finally {
      closeSync(fd);
    }
  });

  test("does not follow a debug symlink", () => {
    writeFileSync(config, '{"debug":true}');
    symlinkSync(config, `${config}.debug.json`);
    writeDebugSnapshot({ generation: 1 });
    expect(read()).toEqual({ debug: true });
    expect(lstatSync(`${config}.debug.json`).isSymbolicLink()).toBe(true);
  });
});
