# Troubleshooting

[← Documentation](../README.md#documentation)

## Connecting

**"The router's web server refused VyGi's address"**
VyOS only lets the addresses under `service https allow-client` use its API, and VyGi's isn't one of them. On the router:
```
configure
set service https allow-client address <VyGi's address, or its network like 192.168.1.0/24>
commit
save
```
With Docker, VyGi's address as the router sees it is the Docker host's address.

**"API key rejected"**
The key in VyGi doesn't match `service https api keys` on the router. In the Connect dialog, open **More options** and enter the right key, or leave it empty to let VyGi set up a new one over SSH.

**The router can't be reached**
VyGi tries SSH as well and tells you which it is. If only the API is off, it offers to turn it back on over SSH. If nothing answers, check the cable, the address, and whether a recent change cut VyGi off; with Safe Mode on, wait for the countdown to undo it.

**"The certificate (or host key) changed"**
Expected after reinstalling VyOS: forget the router (router card → trash icon) and add it again. If you didn't change anything, don't trust it: something may be in between.

## The router

**It forgot its settings after a restart**
Either VyOS runs from the installer (the Health Check says so; run `install image` on the console and remove the installer), or the changes weren't saved (turn on **Save changes automatically**). When the router comes back without its API, the Connect dialog offers **Restore a backup…** over SSH.

**"Log stream ended" / commands need sudo**
The log, Torch, the packet sniffer and DHCP leases use `sudo` over SSH. That works for VyOS admin logins by default. A login VyGi created (`vygi`) is an admin login.

**`id vygi: no such user`**
VyGi's own login hasn't been made on this router yet (for example after a reinstall). System → Router → **Open checklist** → VyGi's own login → **Make one**.

**The Health Check says the router can be reached from the internet, but it's behind my main router**
When its internet address is private, VyGi shows this as advice: the internet only reaches it through ports your main router forwards. Block it before the router faces the internet directly. VyGi won't block it while it connects through that port itself, because that would cut it off.

**Intrusion Prevention: "the rules couldn't be downloaded"**
The router needs working DNS and internet access. Check Network → Internet, then **Update rules**.

## Features

**A port forward works from outside but not from home**
Forwards don't loop back. From inside, use the device's local address.

**The VPN doesn't connect from outside**
The router must be reachable from the internet on the VPN's UDP port. Behind another router (your provider's modem), forward that port to this router there, or put the modem in bridge mode. The Health Check warns when the VPN port is closed.

**Site blocking misses things**
Sites are blocked by the addresses their names point to, which big services share and change. For reliable blocking use Technitium (Security → Content Filtering).

**Speeds per device show nothing**
Turn on traffic counting (Devices → **Turn on traffic counting**).

## The web server

**Forgot the web password, or locked out**
Set `VYGI_PASSWORD` to a new one and restart: `docker compose up -d vygi`. A lockout after wrong passwords also clears with `docker restart vygi`.

**The browser says the certificate doesn't match the address**
Add the address you use to `VYGI_HOSTNAMES` (e.g. `vygi.lan,192.168.1.10`) and restart. VyGi makes a new certificate; the Android app then asks you to accept its new fingerprint.

**An update didn't change anything**
The image is built by GitHub Actions after each change and takes about 15–20 minutes. Check that the latest **Build** run is green, then pull again:
```
docker compose pull vygi && docker compose up -d vygi
```

**Pages are slow to fill in**
Some router commands (DHCP leases, VPN status, connections) can take several seconds, and VyOS answers one request at a time. Pages show after about 2.5 seconds and fill those in when they arrive. Right after connecting it's slower, while the connect check-up runs.
