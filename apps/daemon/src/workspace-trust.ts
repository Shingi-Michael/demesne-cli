import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

/// Folders the user has said they trust. Opening a workspace lets its
/// instruction files, project commands and config steer the agent, so each
/// canonical root is confirmed once; trusting a folder covers its subfolders.
export class WorkspaceTrust {
  constructor(private readonly path: string) {}

  private read(): string[] {
    if (!existsSync(this.path)) return [];
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(value?.trusted) ? value.trusted.filter((root: unknown): root is string => typeof root === "string") : [];
    } catch {
      return [];
    }
  }

  isTrusted(root: string): boolean {
    return this.read().some((trusted) => {
      const path = relative(trusted, root);
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
    });
  }

  trust(root: string): void {
    const trusted = this.read();
    if (trusted.includes(root)) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ trusted: [...trusted, root].sort() }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
