# The Internal Brain API. Build from the repository root:
#   docker build -f infra/tencent/Dockerfile .
FROM node:22-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install only the API, its workspace packages and the root tools (tsx) from the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/audit/package.json packages/audit/
COPY packages/connectors/package.json packages/connectors/
COPY packages/fga-adapter/package.json packages/fga-adapter/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/types/package.json packages/types/
RUN pnpm install --frozen-lockfile --filter internal-brain --filter "@brain/api..."

# Only what the API runs. Nothing from infra/ (where the server keeps sso.env and the audit key) enters the image.
COPY tsconfig.json ./
COPY data/mock data/mock
COPY packages packages
COPY apps/api apps/api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# The model usage counts live here, on a volume; a new volume takes this folder's owner.
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
USER node
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
