# Limitations

[← Documentation](../README.md#documentation)

## VyOS versions

- VyGi targets current VyOS (1.5, Stream and rolling). The forms use 1.5's settings (e.g. DHCP `subnet-id`); VyOS 1.4 isn't supported by them.
- UPnP isn't offered: current VyOS versions don't include it.

## Features

- **Site blocking** works by the addresses a site's names point to (refreshed periodically). Services that share servers (YouTube and Google) can't be told apart, apps may use other names, and it covers IPv4 only. "Block the internet" rules and isolation also block IPv6. For reliable site blocking, use Technitium.
- **Blocking a device** matches its MAC address, so devices with private, changing MAC addresses can get around it.
- **Speed limits** (Queues, group limits) cover IPv4 and match the device's address, so give it a fixed IP. Downloads are shaped assuming a 1 Gbit/s LAN port; uploads are policed (dropped above the limit), so TCP uploads can look bursty.
- **Port forwards** and the VPN's public address are IPv4 only, and forwards don't loop back (use the local address from inside).
- **The VPN client** routes IPv4 only.
- **Torch** reads tcpdump with a short snapshot; on a very busy link (hundreds of Mbit/s) it costs router CPU and may read low.
- **Firewall and NAT forms** cover the common fields. Other options are kept when you edit a rule, and are editable in the configuration tree.
- **Routing protocols, IPsec and OpenVPN setup** and most system settings use the configuration tree, not their own forms.
- **Restore** accepts config.boot files, not `set` command exports.
- **Devices** shows what the router can see (ARP, DHCP, VPN). **Sites** cover connections open right now unless 24/7 watching records them; without Technitium, CDNs can show under their own name.
- **Technitium**: devices show by name only if they ask Technitium directly (use **Use for LAN**).
- **Desktop app**: alerts only run while it's open, and several windows on one router each alert. The web server's 24/7 watching doesn't have this limit.
- VyOS answers with errors for a few seconds while it saves or restarts its API. VyGi retries reading but never retries a change.

## Not yet tested end to end

VyGi is tested against a real VyOS router running in a container. Some things that container can't do:

- **VLANs and bridges with VLAN filtering**: VyOS accepted the settings, but the container's kernel can't create them. Networks on their own port were tested end to end.
- **Speed limits**: accepted by VyOS, but the container can't run the traffic shaping, so real limiting hasn't been measured.
- **IPv6 rules**: accepted and applied, but the container has no IPv6 traffic.
- **WireGuard servers** were tested end to end earlier; the container's kernel later lost WireGuard support.
- **Intrusion Prevention**: VyOS accepted the Suricata container setup, and alert reading and blocking were tested with real-format alerts, but Suricata itself couldn't be downloaded there.
- **The speed test** and **the Technitium query log** couldn't be run there either.
