FROM --platform=$BUILDPLATFORM golang:1.27@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/switchboard ./cmd/switchboard \
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
