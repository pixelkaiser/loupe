import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMETRICS_PANEL,
  builtinWhipPanel,
  DEFAULT_MODEL,
  loadConfig,
} from "../src/config";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("builtin whip panel", () => {
  it("covers the default model", () => {
    expect(DEFAULT_MODEL).toBe("deepseek-flash");
    expect(builtinWhipPanel(DEFAULT_MODEL)).toBe(ADMETRICS_PANEL);
  });

  it("covers served DeepSeek models", () => {
    expect(builtinWhipPanel("deepseek-v4-pro")).toBe(ADMETRICS_PANEL);
  });

  it("stays out of the way of other models", () => {
    expect(builtinWhipPanel("kimi-k3")).toBeUndefined();
    expect(builtinWhipPanel("claude-opus-4-8")).toBeUndefined();
  });

  it("targets the gateway and its separate API key env", () => {
    expect(ADMETRICS_PANEL.provider.baseUrl).toBe(
      "https://llm.admetrics.dev/v1",
    );
    expect(ADMETRICS_PANEL.provider.apiKeyEnv).toBe("ADMETRICS_LLM_API_KEY");
    expect(ADMETRICS_PANEL.models).toContain(ADMETRICS_PANEL.defaultModel!);
  });
});

describe("shared whip provider override", () => {
  function configure(): void {
    const dir = mkdtempSync(join(tmpdir(), "loupe-provider-test-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, ".loupe.json"),
      JSON.stringify({
        model: "deepseek-v4-pro",
        whip: {
          provider: {
            name: "deepseek",
            baseUrl: "https://api.deepseek.com",
            apiKeyEnv: "DEEPSEEK_API_KEY",
          },
          models: ["deepseek-v4-pro"],
        },
        reviewers: [{ name: "code", reasoning: "medium", agentic: false }],
      }),
    );
    vi.stubEnv("GITLAB_CI", "true");
    vi.stubEnv("GITLAB_TOKEN", "test-token");
    vi.stubEnv("CI_PROJECT_PATH", "admetrics/example");
    vi.stubEnv("CI_MERGE_REQUEST_IID", "1");
    vi.stubEnv("CI_PROJECT_DIR", dir);
    vi.stubEnv("LOUPE_CONFIG", ".loupe.json");
    vi.stubEnv("LOUPE_MODEL", "");
    vi.stubEnv("LOUPE_WHIP_CONFIG", JSON.stringify(ADMETRICS_PANEL));
  }

  it("switches an existing repo's pinned provider and model via CI", () => {
    configure();
    const config = loadConfig();
    expect(config.model).toBe("deepseek-flash");
    expect(config.whipConfig).toEqual(ADMETRICS_PANEL);
  });

  it("lets an explicit model input override the shared default model", () => {
    configure();
    vi.stubEnv("LOUPE_MODEL", "deepseek-v4-pro");
    expect(loadConfig().model).toBe("deepseek-v4-pro");
  });

  it("retains repo provider settings when no CI override is supplied", () => {
    configure();
    vi.stubEnv("LOUPE_WHIP_CONFIG", "");
    const config = loadConfig();
    expect(config.model).toBe("deepseek-v4-pro");
    expect(config.whipConfig?.provider.baseUrl).toBe(
      "https://api.deepseek.com",
    );
  });

  it("rejects an incomplete shared provider panel", () => {
    configure();
    vi.stubEnv("LOUPE_WHIP_CONFIG", '{"provider":{"name":"admetrics"}}');
    expect(() => loadConfig()).toThrow();
  });
});
