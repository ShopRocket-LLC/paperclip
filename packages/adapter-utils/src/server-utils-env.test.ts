import { describe, expect, it } from "vitest";
import { readShellEnvPassthroughKeys, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("readShellEnvPassthroughKeys", () => {
  it("splits on commas and whitespace and drops invalid or credential-like names", () => {
    expect(readShellEnvPassthroughKeys({
      PAPERCLIP_AGENT_SHELL_ENV_PASSTHROUGH: "DOCKER_HOST, OKTO_ENV_HOME\nPLAYWRIGHT_BROWSERS_PATH HOST_API_TOKEN my_secret SSH_KEY 1BAD not-a-name!",
    })).toEqual(["DOCKER_HOST", "OKTO_ENV_HOME", "PLAYWRIGHT_BROWSERS_PATH"]);
  });

  it("returns nothing when unset or empty", () => {
    expect(readShellEnvPassthroughKeys({})).toEqual([]);
    expect(readShellEnvPassthroughKeys({ PAPERCLIP_AGENT_SHELL_ENV_PASSTHROUGH: "" })).toEqual([]);
  });
});
