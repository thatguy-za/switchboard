FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/switchboard ./cmd/switchboard \
 && mkdir /out/data /out/keys

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/switchboard /switchboard
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/keys /keys
ENV SWITCHBOARD_PORT=8080
EXPOSE 8080
VOLUME ["/data", "/keys"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/switchboard", "-healthcheck"]
ENTRYPOINT ["/switchboard"]
