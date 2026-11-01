FROM --platform=$BUILDPLATFORM golang:1.23 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/switchboard ./cmd/switchboard

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/switchboard /switchboard
ENV SWITCHBOARD_PORT=8080
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/switchboard", "-healthcheck"]
ENTRYPOINT ["/switchboard"]
