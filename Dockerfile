FROM --platform=$BUILDPLATFORM golang:1.26 AS build
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
FROM guacamole/guacd:1.6.0
COPY --from=build /out/switchboard /switchboard
COPY --from=build --chown=1000:1000 /out/data /data
ENV SWITCHBOARD_PORT=3000
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/switchboard", "-healthcheck"]
ENTRYPOINT ["/switchboard"]
