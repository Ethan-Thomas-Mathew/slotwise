# Frontend image: static files served by nginx, which also forwards /api/* to
# the API. Browser and API then share one origin, so cookies need no CORS setup.
#   docker build -f apps/web/Dockerfile -t slotwise-web .
#   docker run -e API_URL=http://api:3000 -p 8080:8080 slotwise-web

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @slotwise/web build

# nginx's stable branch (1.27 no longer receives fixes). apk upgrade picks up Alpine
# security fixes published since the base image was built.
FROM nginx:1.30-alpine
RUN apk upgrade --no-cache
ENV API_URL=http://api:3000
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
