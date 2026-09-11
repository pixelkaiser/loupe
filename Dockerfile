# loupe as a container image: bun + git, ready to run the CI entry
# (bun run packages/action/src/main.ts). Built and pushed to the project's
# GitLab container registry by .gitlab-ci.yml (docker:image job).
FROM oven/bun:1.3.14-debian

# git: agentic reviewers explore a real checkout; the fix path shells out to it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /loupe
COPY . .
RUN bun install --frozen-lockfile --production

# No ENTRYPOINT on purpose: as a GitLab CI job image the runner supplies the
# command. To review an MR with this image:
#   script: [bun run /loupe/packages/action/src/main.ts]
