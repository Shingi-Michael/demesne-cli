import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkKeychain, signinEnv } from "../src/tools.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "demesne-signins-"));

test("commands read your own gh config and global git config, not the scratch home's", () => {
  const home = scratch();
  try {
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Someone\n");
    expect(signinEnv(home, { SSH_AUTH_SOCK: "/tmp/agent.sock" })).toEqual({
      GH_CONFIG_DIR: join(home, ".config", "gh"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    // Explicit settings win; nothing is invented when there is nothing there.
    expect(signinEnv(home, { GH_CONFIG_DIR: "/elsewhere/gh", GIT_CONFIG_GLOBAL: "/elsewhere/git" })).toEqual({ GH_CONFIG_DIR: "/elsewhere/gh", GIT_CONFIG_GLOBAL: "/elsewhere/git" });
    expect(signinEnv(scratch(), {})).toEqual({});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("on a Mac the scratch home links to your keychain folder once; elsewhere it doesn't", () => {
  const home = scratch(), tool = scratch(), other = scratch();
  try {
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    linkKeychain(tool, home, "darwin");
    linkKeychain(tool, home, "darwin");
    const link = join(tool, "Library", "Keychains");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(home, "Library", "Keychains"));
    linkKeychain(other, home, "linux");
    expect(lstatSync(join(other, "Library"), { throwIfNoEntry: false })).toBeUndefined();
  } finally { for (const dir of [home, tool, other]) rmSync(dir, { recursive: true, force: true }); }
});
