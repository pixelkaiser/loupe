#!/usr/bin/env bun
import { createRootLogger, shutdownLogger } from "@loupe/logger";

import { isGitlabNonMrPipeline, loadConfig } from "./config";
import { runReviews } from "./orchestrate";
import { handleComment } from "./respond";

const logger = createRootLogger("loupe-action");

const COMMENT_EVENTS = new Set([
  "issue_comment",
  "pull_request_review_comment",
]);

async function main(): Promise<void> {
  // GitLab runs the same entry on branch/tag pipelines, where there is no MR
  // to review — exit cleanly instead of failing the pipeline.
  if (isGitlabNonMrPipeline()) {
    logger.info("Not a merge-request pipeline; nothing to review");
    return;
  }
  const config = loadConfig();
  if (config.eventName && COMMENT_EVENTS.has(config.eventName)) {
    await handleComment(config, logger);
    return;
  }
  await runReviews(config, logger);
}

main()
  .catch((err: unknown) => {
    logger.error("loupe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(() => shutdownLogger());
