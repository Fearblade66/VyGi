# Advanced

[← Documentation](../README.md#documentation)

**Advanced** in the sidebar is the expert side: every VyOS feature as a window, Winbox-style. Each page also has an **Advanced ▾** menu next to its title that opens the related windows (Devices → DHCP Leases, ARP, Queues; Port Forwarding → NAT…), and each item's **⋯** menu opens the configuration at exactly that item.

## Windows

- On a desktop-sized screen, tools open as floating windows you can arrange side by side. Windows stay inside the area and cling to its edges and to each other. Drag one against the left or right edge to fill that half, or against the top to fill the area; an outline shows where it will go. **Tile** lays them all out in a grid.
- The **Tabs** switch (right of the window strip) shows one at a time instead, the default on small screens. **+** shows the tool list.
- Click a column header to sort (again to reverse, a third time for the original order). Drag a column edge to resize it, double-click to reset. Right-click a row for that window's actions (Edit, Enable, Disable, Move up…).
- **Managed by**: firewall rules, NAT rules and address lists made by a simple page are tagged with it (Traffic Rules: Kids bedtime, Port Forwarding: Plex…), and the tag opens that page. Changing one here asks first: open that page, change it here anyway, or **make it manual** (VyGi stops managing it).

## The tools

| Tool | What you get |
|---|---|
| **Interfaces** | Live table with type, comment, addresses, MAC, MTU, Tx/Rx rates and a sparkline. Add VLAN, bridge or dummy interfaces; enable, disable, edit, remove. **Traffic** shows a live graph; **Torch** a per-conversation view. |
| **IP → Addresses** | Every address on every interface, including DHCP ones. Add and remove static addresses. |
| **IP → Routes** | The routing table per VRF, IPv4 or IPv6. Add and remove static routes. |
| **IP → ARP / Neighbors** | The ARP/NDP table and devices found by LLDP (switches, access points, other routers). One click turns LLDP on. |
| **IP → DHCP Server / Leases** | Set up a DHCP server on an interface (pool, gateway, DNS and lease suggested), see leases, manage reservations. **Make Static** turns a lease into a reservation. |
| **IP → DNS** | The router's own DNS servers, DNS forwarding and static host names. |
| **IP → DNS Server (Technitium)** | Link a [Technitium DNS Server](https://technitium.com/dns/): stats, top clients and domains, block or allow lists, pause blocking, the query log, and **Use for LAN** (DHCP hands out Technitium so it sees each device). Home gets a DNS card and Devices a DNS log per device. |
| **IP → Dynamic DNS** | Keep a name like home.example.com pointed at your changing address: Cloudflare, DuckDNS, No-IP, Namecheap, Porkbun and the other providers VyOS supports. The form asks only for what the provider needs. |
| **IP → Services** | SSH, HTTPS API, DNS, DHCP, NTP, LLDP, SNMP, mDNS and more, with on/off and details. You can't switch off the access VyGi itself needs. |
| **Firewall** | Rules per chain (forward, input, output, custom) for IPv4 and IPv6: add, edit, remove, enable, disable, reorder; default actions (with lock-out warnings); custom chains. |
| **NAT** | Source NAT (masquerade) and destination NAT (port forwards) with guided forms. |
| **Firewall → Address Lists, Connections** | Address, network, port and MAC groups as editable lists; the live connection table with the busiest hosts. |
| **Queues** | Speed limits per device (by IPv4 address), Winbox Simple Queues style. |
| **VPN** | WireGuard **Quick Setup** and devices with QR codes (keys made on your side, so a device's private key never touches the router), live peers; IPsec and OpenVPN status. |
| **Routing Protocols, VRF, System settings** | The configuration tree for that section. |
| **Tools** | Ping, Traceroute, **Torch** (live rate per conversation on an interface), Packet Sniffer, **IP Scan** (which addresses answer, with MACs and names), Profile (busiest processes). |
| **Log** | The live system journal with severity and text filters. |
| **System → Resources** | CPU and memory graphs, uptime, temperatures, storage. |
| **System → Identity & Clock** | Router name, domain, time zone, NTP servers. |
| **System → Users** | Router logins: add or remove users, change passwords, SSH keys. You can't delete the login VyGi uses. |
| **System → Images (Upgrade)** | Install, set as default and delete VyOS versions. |
| **System → Revisions / Rollback** | Commit history with a diff, and rollback to any revision without restarting. |
| **System → Backup / Restore** | Save the configuration to a file (config.boot or `set` commands), restore a config.boot through Safe Mode, and browse the automatic backups. |
| **System → Check-up** | The connect check-up: backup, what changed since your last visit, health. |
| **System → Diagnostics Report** | A Markdown report of the router for Claude or support, secrets removed. |
| **System → Full Configuration** | The whole configuration as a tree: browse, set, delete, and view as `set` commands. |
| **System → Reboot / Shut Down** | With a warning about unsaved or unconfirmed changes. |
| **New Terminal** | A full SSH terminal. |
