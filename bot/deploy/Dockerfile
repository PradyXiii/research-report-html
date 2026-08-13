# OPTIONAL. The bot does not need a container -- it is Node plus one pure-JS
# dependency and runs on any Linux box. This exists only if the platform team
# would rather ship an image than manage a Node install.
#
#   docker build -f bot/deploy/Dockerfile -t kotak-research-bot .
#   docker run --rm --env-file bot.env -v /var/lib/kotak-research-bot:/state \
#     kotak-research-bot --live
#
# Build context is the REPOSITORY ROOT, because the bot renders through
# ../src/render.js.

FROM node:22-bookworm-slim

RUN useradd --system --create-home --uid 10001 kotakbot
WORKDIR /opt/kotak-research-bot

# Dependencies first, so a code change does not re-download pdfjs-dist.
COPY bot/package.json bot/package-lock.json ./bot/
RUN cd bot && npm ci --omit=dev --omit=optional && npm cache clean --force

# The renderer and its stylesheet are part of the runtime.
COPY src ./src
COPY schema.json ./
COPY bot ./bot

ENV NODE_ENV=production \
    BOT_STATE_DIR=/state \
    BOT_LOG_FORMAT=json
RUN mkdir -p /state && chown kotakbot:kotakbot /state
VOLUME ["/state"]

USER kotakbot
WORKDIR /opt/kotak-research-bot/bot
ENTRYPOINT ["node", "run.js"]
CMD ["--dry-run"]
