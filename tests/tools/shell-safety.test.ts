import { describe, it, expect } from "vitest";
import { classifyCommandEffect, checkShellCommand } from "../../src/index.js";

describe("classifyCommandEffect — read/write", () => {
  it("classifies read-only commands", () => {
    for (const c of ["ls -la", "cat f", "git status", "git log --oneline", "npm ls", "kubectl get pods", "git diff HEAD~1"]) {
      expect(classifyCommandEffect(c)).toBe("read");
    }
  });
  it("classifies mutating commands as write", () => {
    for (const c of ["git push origin main", "npm install x", "kubectl delete pod x", "mkdir foo", "npm test", "cat x | tee out.txt"]) {
      expect(classifyCommandEffect(c)).toBe("write");
    }
  });
});

describe("classifyCommandEffect — false-negative fixes (scan all segments + flags)", () => {
  it("mutation in an earlier segment is not read", () => {
    expect(classifyCommandEffect("rm -f /home/user/notes.txt && echo ok")).toBe("write");
    expect(classifyCommandEffect("mv /data/x /data/y && ls")).toBe("write");
    expect(classifyCommandEffect("git commit -am x && git status")).toBe("write");
  });
  it("write-forcing flags detected", () => {
    expect(classifyCommandEffect("sed -i 's/a/b/' config.txt")).toBe("write");
    expect(classifyCommandEffect("sed 's/a/b/' f")).toBe("read");
    expect(classifyCommandEffect("find . -name x -delete")).toBe("write");
    expect(classifyCommandEffect("awk 'BEGIN{system(\"mv /a /b\")}'")).toBe("write");
    expect(classifyCommandEffect("echo x > file.txt")).toBe("write");
    expect(classifyCommandEffect("cat a >> b.log")).toBe("write");
  });
  it("interpreters are never read", () => {
    expect(classifyCommandEffect("python3 -c 'import shutil'")).toBe("write");
    expect(classifyCommandEffect("node evil.js")).toBe("write");
  });
  it("git config/tag write; git status stays read", () => {
    expect(classifyCommandEffect("git config --global user.email x@y.z")).toBe("write");
    expect(classifyCommandEffect("git tag v1.0")).toBe("write");
    expect(classifyCommandEffect("git status")).toBe("read");
  });
  it("redirection exclusions are correct", () => {
    expect(classifyCommandEffect("grep x f 2>&1")).toBe("read");
    expect(classifyCommandEffect("grep x f >/dev/null")).toBe("read");
  });
});

describe("classifyCommandEffect — destructive", () => {
  it("catches recursive rm incl. split flags", () => {
    expect(classifyCommandEffect("rm -rf /")).toBe("destructive");
    expect(classifyCommandEffect("rm -r -f /home/user/project")).toBe("destructive");
    expect(classifyCommandEffect("rm foo.txt")).toBe("write");
  });
  it("catches fork bomb, dd, mkfs, find -exec rm", () => {
    expect(classifyCommandEffect(":(){ :|:& };:")).toBe("destructive");
    expect(classifyCommandEffect("dd if=/dev/zero of=/dev/sda")).toBe("destructive");
    expect(classifyCommandEffect("mkfs.ext4 /dev/sdb")).toBe("destructive");
    expect(classifyCommandEffect("find /data -type f -exec rm -f {} ;")).toBe("destructive");
  });
});

describe("checkShellCommand — verdicts", () => {
  it("allows legitimate commands", () => {
    for (const c of ["ls -la", "git commit -m 'fix'", "npm test", "cat f | grep foo", "mkdir -p a/b", "echo ${HOME}/bin"]) {
      expect(checkShellCommand(c).verdict).toBe("allow");
    }
  });
  it("blocks command substitution (configurable)", () => {
    expect(checkShellCommand("echo $(cat /etc/passwd)").verdict).toBe("block");
    expect(checkShellCommand("echo `whoami`").verdict).toBe("block");
    expect(checkShellCommand("diff <(ls a) <(ls b)").verdict).toBe("block");
    expect(checkShellCommand("echo $(date)", { substitution: "warn" }).verdict).toBe("warn");
    expect(checkShellCommand("echo $(date)", { substitution: "allow" }).verdict).toBe("allow");
  });
  it("always blocks parser-differential + proc environ (not relaxable)", () => {
    expect(checkShellCommand("ls\r rm -rf /").verdict).toBe("block");
    expect(checkShellCommand("cat /proc/1/environ").verdict).toBe("block");
    expect(checkShellCommand("ls\r foo", { substitution: "allow" }).verdict).toBe("block");
  });
  it("destructive BLOCKS by default, warns only on opt-out", () => {
    expect(checkShellCommand("rm -rf /").verdict).toBe("block");
    expect(checkShellCommand("rm -rf /", { destructive: "warn" }).verdict).toBe("warn");
  });
  it("does not false-positive on the find -exec ... \\; terminator", () => {
    expect(checkShellCommand("find . -name '*.js' -exec grep TODO {} \\;").verdict).toBe("allow");
  });
});
