# Build probe for the inner Docker daemon. The base image is pinned by digest and must come
# from the approved registry (docker.io/library).
# busybox, not alpine: Alpine's busybox has no httpd applet (it is in busybox-extras); found on
# the dev VM, step 40. Same digest as KIT_BUSYBOX_IMAGE in versions.env.
ARG BASE=docker.io/library/busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
FROM ${BASE}
RUN addgroup -S web && adduser -S -G web web && mkdir -p /srv && echo "kit-inner-build-ok $(date -u +%Y%m%d)" > /srv/index.html
USER web
EXPOSE 8080
CMD ["busybox", "httpd", "-f", "-p", "8080", "-h", "/srv"]
