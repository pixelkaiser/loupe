# loupe as a container image: bun + git, ready to run the CI entry
# (bun run packages/action/src/main.ts). Built and pushed to the project's
# GitLab container registry by .gitlab-ci.yml (docker:image job).
FROM oven/bun:1.3.14-debian

# git: agentic reviewers explore a real checkout; the fix path shells out to it.
# curl: used only at build time to fetch the whip release.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The default harness, preinstalled so review jobs work out of the box.
RUN curl -fsSL -o /usr/local/bin/whip \
  https://github.com/context-labs/whip/releases/latest/download/whip-linux-x64 \
  && chmod +x /usr/local/bin/whip

WORKDIR /loupe
COPY . .
RUN bun install --frozen-lockfile --production

# No ENTRYPOINT on purpose: as a GitLab CI job image the runner supplies the
# command. To review an MR with this image:
#   script: [bun run /loupe/packages/action/src/main.ts]
