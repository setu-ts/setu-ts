# Build context: repository root. The frozen workspace lock and source graph track HEAD.
FROM node:24-alpine AS build
ARG APP=minimal
WORKDIR /srv
RUN npm install --global pnpm@12.11.2
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter setu-ts-example-${APP}...
RUN pnpm --filter "setu-ts-example-${APP}^..." exec tsc -b
RUN pnpm --filter setu-ts-example-${APP} deploy --prod /out

FROM node:24-alpine
WORKDIR /srv
COPY --from=build --chown=1000:1000 /out ./
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["main.ts", "3000"]
