#!/bin/sh
# Starts the test router: eth0 = management (Docker bridge), eth1-3 = extra
# networks for WAN/LAN tests, plus an Alpine "LAN client" on eth2's network.
# API: https://<eth0 IP>/ key "vygi-test-key"; SSH: vyos / vyos.
set -eu
docker rm -f vyos lanclient >/dev/null 2>&1 || true
for n in 1 2 3; do docker network create --subnet "10.20.$n.0/24" "vnet$n" >/dev/null 2>&1 || true; done
docker create --name vyos --privileged --hostname vyos --tmpfs /run --tmpfs /tmp \
  -v /lib/modules:/lib/modules:ro vyos:test /sbin/init >/dev/null
for n in 1 2 3; do docker network connect "vnet$n" vyos; done
docker start vyos >/dev/null
# Hosts whose kernel has no IPv6 at all: `ip -6 rule list` fails and VyOS's
# firewall script then refuses every commit. Answer it with an empty list.
docker exec vyos sh -c '[ -e /proc/net/if_inet6 ] && exit 0; ip=$(command -v ip); mv "$ip" "$ip.real"; printf "#!/bin/sh\ncase \" \$* \" in *\" -6 \"*\" rule \"*) echo \"[]\"; exit 0;; esac\nexec %s.real \"\$@\"\n" "$ip" > "$ip"; chmod +x "$ip"'
docker run -d --name lanclient --network vnet2 alpine:3.20 sleep 86400 >/dev/null
IP=$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' vyos)
printf 'Waiting for the API on %s' "$IP"
until curl -sk --max-time 3 -o /dev/null "https://$IP/"; do printf .; sleep 3; done
echo " ready."
