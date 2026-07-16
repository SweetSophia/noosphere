# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# The multi-architecture index digest fixes both the PostgreSQL/Alpine release
# family and each architecture-specific base manifest selected by BuildKit.
ARG POSTGRES_IMAGE=postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777

FROM ${POSTGRES_IMAGE} AS pgvector-build

# GitHub's generated archive is accepted only when its bytes match this lock.
# Tag v0.8.1 resolves to commit 778dacf20c07caf904557a88705142631818d8cb;
# The README documents how to rotate the byte lock if GitHub regenerates it.
# ADD performs the checksum verification before Docker exposes the archive to
# the build, so a moved tag or regenerated archive fails closed.
ADD --checksum=sha256:a9094dfb85ccdde3cbb295f1086d4c71a20db1d26bf1d6c39f07a7d164033eb4 \
  https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz \
  /tmp/pgvector.tar.gz

# Pin every package introduced for compilation. The final stage does not carry
# this toolchain, but exact constraints prevent a later Alpine repository update
# from silently changing the produced extension binary.
RUN apk add --no-cache \
      jansson=2.15.0-r0 \
      binutils=2.45.1-r1 \
      libmagic=5.47-r2 \
      file=5.47-r2 \
      libgcc-static=15.2.0-r5 \
      libgomp=15.2.0-r5 \
      libatomic=15.2.0-r5 \
      gmp=6.3.0-r4 \
      isl26=0.26-r2 \
      mpfr4=4.2.2-r0 \
      mpc1=1.3.1-r1 \
      gcc=15.2.0-r5 \
      libstdc++-dev=15.2.0-r5 \
      musl-dev=1.2.6-r2 \
      g++=15.2.0-r5 \
      make=4.4.1-r4 \
      fortify-headers=3.0.1-r2 \
      patch=2.8-r0 \
      build-base=0.5-r4 \
  && mkdir -p /tmp/pgvector-src /tmp/pgvector-install /tmp/pgvector-docs \
  && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector-src --strip-components=1 \
  && make -C /tmp/pgvector-src clean \
  && make -C /tmp/pgvector-src OPTFLAGS="" with_llvm=no \
  && make -C /tmp/pgvector-src OPTFLAGS="" with_llvm=no DESTDIR=/tmp/pgvector-install install \
  && cp /tmp/pgvector-src/LICENSE /tmp/pgvector-src/README.md /tmp/pgvector-docs/

FROM ${POSTGRES_IMAGE}

LABEL org.opencontainers.image.title="Noosphere PostgreSQL with pgvector" \
      org.opencontainers.image.description="Pinned PostgreSQL 16 Alpine database image with pgvector for Noosphere" \
      org.opencontainers.image.source="https://github.com/SweetSophia/noosphere" \
      org.opencontainers.image.licenses="PostgreSQL" \
      org.opencontainers.image.base.name="docker.io/library/postgres:16.14-alpine3.24" \
      org.opencontainers.image.base.digest="sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777" \
      io.noosphere.postgresql.version="16.14" \
      io.noosphere.alpine.version="3.24.1" \
      io.noosphere.pgvector.version="0.8.1" \
      io.noosphere.pgvector.source.commit="778dacf20c07caf904557a88705142631818d8cb" \
      io.noosphere.pgvector.source.url="https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz" \
      io.noosphere.pgvector.source.sha256="a9094dfb85ccdde3cbb295f1086d4c71a20db1d26bf1d6c39f07a7d164033eb4" \
      io.noosphere.pgvector.license="PostgreSQL" \
      io.noosphere.pgvector.optflags="portable" \
      io.noosphere.pgvector.llvm-bitcode="disabled"

COPY --from=pgvector-build /tmp/pgvector-install/usr/local/ /usr/local/
COPY --from=pgvector-build /tmp/pgvector-docs/ /usr/share/doc/pgvector/
