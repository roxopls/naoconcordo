FROM rust:1.89-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM alpine:3.22
RUN addgroup -S naoconcordo && adduser -S -G naoconcordo naoconcordo && mkdir -p /app/data && chown -R naoconcordo:naoconcordo /app
COPY --from=builder /build/target/release/naoconcordo-server /usr/local/bin/naoconcordo-server
USER naoconcordo
EXPOSE 3040
CMD ["naoconcordo-server"]

