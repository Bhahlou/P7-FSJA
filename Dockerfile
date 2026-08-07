# syntax=docker/dockerfile:1

FROM node:20-alpine AS front-build

WORKDIR /src

COPY front/package.json front/package-lock.json ./
RUN npm ci

COPY front/ ./
RUN npx @angular/cli build --optimization


FROM gradle:8.7-jdk17-alpine AS back-build

WORKDIR /src

COPY back/ ./
RUN ./gradlew build --no-daemon

FROM caddy:2-alpine AS front

RUN addgroup -S app && adduser -S app -G app

ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
RUN mkdir -p /config /data && chown -R app:app /config /data

COPY --from=front-build /src/dist/microcrm/browser /app/front
COPY misc/docker/Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/ >/dev/null || exit 1

FROM eclipse-temurin:17-jre-alpine AS back

RUN addgroup -S app && adduser -S app -G app
USER app

WORKDIR /app
COPY --from=back-build /src/build/libs/microcrm-0.0.1-SNAPSHOT.jar microcrm.jar

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8080/ >/dev/null || exit 1

CMD ["java", "-jar", "microcrm.jar"]
