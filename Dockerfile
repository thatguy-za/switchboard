FROM --platform=$BUILDPLATFORM golang:1.26@sha256:670bb5aa5349ae03b8516764718486f4f16399134bdc9acd0c46a23f043ab05c AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/switchboard ./cmd/switchboard \
 && mkdir /out/data

# guacd (the Apache Guacamole proxy that does the RDP) is published for amd64 and arm64.
# It runs as uid 1000, and Switchboard starts it, so one container does everything.
FROM guacamole/guacd:1.6.0@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f
COPY --from=build /out/switchboard /switchboard
COPY --from=build --chown=1000:1000 /out/data /data
ENV SWITCHBOARD_PORT=3000
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/switchboard", "-healthcheck"]
ENTRYPOINT ["/switchboard"]
