import { describe, expect, it } from "vitest";

import { builtinWhipPanel, DEEPSEEK_PANEL, DEFAULT_MODEL } from "../src/config";

describe("builtin whip panel", () => {
  it("covers the default model", () => {
    expect(builtinWhipPanel(DEFAULT_MODEL)).toBe(DEEPSEEK_PANEL);
  });

  it("covers served DeepSeek models", () => {
    expect(builtinWhipPanel("deepseek-v4-pro")).toBe(DEEPSEEK_PANEL);
  });

  it("stays out of the way of other models", () => {
    expect(builtinWhipPanel("kimi-k3")).toBeUndefined();
    expect(builtinWhipPanel("claude-opus-4-8")).toBeUndefined();
  });

  it("targets the DeepSeek API key env", () => {
    expect(DEEPSEEK_PANEL.provider.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(DEEPSEEK_PANEL.models).toContain(DEEPSEEK_PANEL.defaultModel!);
  });
});
