FROM eclipse-temurin:17-jdk-alpine AS base

RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    unzip \
    zip \
    bash \
    ca-certificates

ARG DITA_OT_VERSION=4.2.4
ENV DITA_OT_VERSION=${DITA_OT_VERSION}
ENV DITA_OT_HOME=/opt/dita-ot

RUN curl -fsSL \
    "https://github.com/dita-ot/dita-ot/releases/download/${DITA_OT_VERSION}/dita-ot-${DITA_OT_VERSION}.zip" \
    -o /tmp/dita-ot.zip \
    && unzip -q /tmp/dita-ot.zip -d /opt \
    && mv /opt/dita-ot-${DITA_OT_VERSION} ${DITA_OT_HOME} \
    && chmod +x ${DITA_OT_HOME}/bin/dita \
    && rm /tmp/dita-ot.zip

RUN addgroup -S ditaworker && adduser -S -G ditaworker ditaworker

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./

RUN chown -R ditaworker:ditaworker /app
RUN mkdir -p /tmp/dita-jobs && chown ditaworker:ditaworker /tmp/dita-jobs

USER ditaworker

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
