# VyOS test router for VyGi's end-to-end tests.
# Base image `vyos:rolling` comes from build-image.sh (the official ISO's root filesystem).
FROM vyos:rolling
COPY default.boot /opt/vyatta/etc/config.boot.default
COPY default.boot /usr/share/vyos/config.boot.default
COPY default.boot /opt/vyatta/etc/config/config.boot
# A real install generates this certificate; the ISO root filesystem doesn't have it.
RUN make-ssl-cert generate-default-snakeoil --force-overwrite
# Sandboxes without IPv6: pim6d aborts and blocks `vtysh write`.
RUN sed -i 's/^pim6d=yes/pim6d=no/' /usr/share/vyos/templates/frr/daemons.frr.tmpl
ENV LANG=C.UTF-8
# Containers can't load kernel modules; the features VyGi tests are built in.
RUN for f in modprobe rmmod insmod; do p=$(command -v $f); [ -n "$p" ] && rm -f "$p" && printf '#!/bin/sh\nexit 0\n' > "$p" && chmod +x "$p"; done; true
# Stable SSH host keys across container restarts.
RUN ssh-keygen -A
