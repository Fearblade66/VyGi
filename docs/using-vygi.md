# A tour of VyGi

[← Documentation](../README.md#documentation)

The sidebar has **Home, Devices, Network, Security, Activity, System** and **Advanced**. Network, Security, Activity and System each hold a few pages, shown as tabs under the top bar; VyGi reopens the tab you used last.

On a phone the main pages are tabs at the bottom, and the rest is behind **More**.

- [Around the edges](#around-the-edges): router switcher, top bar, search, account menu
- [Home](#home)
- [Devices](#devices)
- [Network](#network): Internet, Local Networks, VPN
- [Security](#security): Traffic Rules, Network Policies, Port Forwarding, Content Filtering, Intrusion Prevention
- [Activity](#activity): Traffic & Logs, Changes & Backups
- [System](#system): Router, VyGi
- [Advanced](#advanced)

## Around the edges

**Router card** (top of the sidebar): the router this window is connected to. Click it to switch to another saved router, open one in a new window, forget one, **+ Add router**, or disconnect. The web version shows each router's 24/7 status there.

**Top bar**: the page's **Advanced ▾** menu (the matching expert windows), search, **Safe Mode** with its countdown, **Confirm** while a change waits, alerts (the bell), **Save** and **Terminal**.

**Search and actions** (Ctrl+K): opened empty, it suggests common actions. Type to find:
- actions: save, Safe Mode on/off, open terminal, Health Check, add a port forward / VPN device / network / traffic rule, Make it a router, switch or add a router, disconnect, light or dark look;
- pages, by their menu names;
- everyday words: "password", "open port", "bedtime", "time zone";
- devices (name, IP, MAC), networks, rules, forwards, VPN devices;
- any setting in the router's configuration (secrets excluded).

**Show commands** (top bar, on Network and Security): shows the VyOS commands behind each item, under it.

**⋯ on an item**: **Open in Advanced** opens the configuration at exactly that item (its interface, DHCP server, NAT or firewall rule, group, or VPN peer).

**Problems on the item**: when the Health Check finds something wrong with a network, port forward, VPN server or the internet connection, it shows on that card with a Fix button.

**Account and settings** (bottom of the sidebar): VyGi's own settings: API tokens and Claude, the phone app, the web password, saving automatically, the look (Modern light/dark/system, or Classic Winbox gray), and logging out.

## Home

Internet status and latency, live internet traffic, CPU and memory, devices online, your networks with how full their DHCP pools are, the busiest devices, top sites and countries, VPN devices and alerts. The Health Check card appears when something needs attention. **Run speed test** measures the router's own internet speed against Cloudflare: 8 parallel downloads for 8 seconds, then 8 uploads (uses a few GB on a fast line).

With two or more routers on the web version, **Your routers** shows each one's 24/7 state and today's alerts.

## Devices

Every device the router knows about, from ARP, DHCP, fixed IPs, local DNS names and the VPN, with live speeds. Click one for its details and actions:

- **Wake up** (Wake-on-LAN), **Rename**, **Fixed IP**, **Limit speed**, **Block**, **Ping**;
- **Approve**: for a new device held by [quarantine](#protection) (tagged *held*; the **Held** filter lists them);
- **What can it reach?**: for the internet and each other network, which rule decides, what only blocks part of it (a schedule, sites, ports, countries), and the page that made each rule;
- **Data usage** (web version) and **DNS log** (with Technitium).

**Groups…** makes named sets of devices (Kids, Smart TVs). Traffic Rules, policies and the VPN client can target a group, so adding a device to the group applies all its rules. A group can also carry a speed limit per device.

Live speeds per device need traffic counting, which VyOS leaves off; the page has a one-click **Turn on traffic counting**. **Sites** shows where each device's traffic goes, with names from Technitium when you have it, otherwise by network owner, plus the country (from DB-IP Lite, downloaded once and looked up locally).

## Network

### Internet

How the router gets online, and its address, gateway, Dynamic DNS and speed.

- **Connection**: automatic (DHCP), PPPoE (username and password from your provider), or a fixed address, with an optional VLAN tag for providers that need one, and IPv6 from your provider (prefix delegation, one /64 per chosen network). Changing it moves every rule that names the internet port (NAT, firewall, forwards, queues, failover, Dynamic DNS) to the new one.
- **Make it a router**: see below.
- **Internet address**: warns when another router sits in front (a private address), because then the internet only reaches this one through ports that router forwards.
- **Smart Queues**: CAKE shaping of uploads to 90% of your line, so big uploads don't make games and calls lag. VyOS can't CAKE-shape downloads.
- **DNS servers**: automatic from your provider, Cloudflare, Quad9, Google or your own.
- **Backup internet (WAN2)**: failover to a second line. VyOS pings through both lines; after 3 failed checks new connections use the backup, and they move back after 3 good ones. Port forwards and the VPN still only work on the main line.

#### Make it a router

One form for a new router or a fresh start:

- **Internet port** and how it connects: keep the current connection, DHCP, PPPoE or a fixed address.
- **Home network**: an existing network, or a new one on free ports (several ports are bridged so they act like one switch), with its address and DHCP range.

It sets up, as one change: the internet connection, DHCP, the router as DNS server, NAT to the internet, and the basic firewall (block new connections from the internet to the router and, with IPv6, to your devices; DNS answers only for your networks; SSH guessing protection). The change is always shown before it's applied, and runs in Safe Mode. Running it on a router that's already set up changes nothing.

If VyGi itself connects through the port you chose for the internet, it says so first and doesn't block that side, because that would cut VyGi off.

### Local Networks

Each network as a card: subnet, gateway, VLAN or ports, devices online, DHCP pool use. **New network** sets one up on a VLAN, a free port, or several ports bridged, with the gateway, DHCP, DNS, internet access and optional isolation:

- **Standard**: a normal network.
- **Guest**: internet only; can't reach your other devices or the router's settings.
- **IoT**: isolated, no internet.

The **Ports** view shows the router's physical ports: cable state, speed, role, networks and VLANs, switches or access points announcing themselves there (LLDP), and the devices behind each port.

### VPN

WireGuard, so you can reach home and use your home internet from anywhere.

- **Set up VPN** creates the server and shows a QR code for the first phone or laptop; **Add device** adds more. Each device shows whether it's connected, when it was last seen, data used and where it connects from.
- **Show config** shows a device's config file and QR code again. VyGi keeps them in its private data folder because they hold the device's private key. Devices added before VyGi kept them get **Make a new config**.
- Devices can be paused or removed. The public address defaults to your Dynamic DNS name, or the router's internet address.

**VPN client** (same page): connect the router to a VPN provider (Mullvad, Proton VPN, IVPN…) by pasting the provider's WireGuard config, then choose which devices, groups or networks go through it. Everything else uses your normal line. **Kill switch** (on by default): if the tunnel is down, those devices get no internet instead of leaking onto the normal line. IPv4 only.

## Security

### Traffic Rules

Block the internet, or specific sites, for chosen devices, groups or networks, always or on a schedule ("Kids bedtime, Sun–Thu 22:00–07:00"). Each rule has an on/off switch and shows whether it's blocking right now. Schedules follow the router's clock and time zone; the page shows the router's current time.

Site blocking works by the addresses a site's names point to, so big services that share servers (YouTube and Google) can't be told apart. For reliable site blocking, use Technitium (Content Filtering).

### Network Policies

- **Who can reach whom**: a grid of which networks may start connections to which, plus policies that allow or block traffic from a network, group or device to a network or device, optionally only some ports. Policies come first, so an allow is an exception to an isolated network.
- **Device discovery across networks**: repeats mDNS (Chromecast, AirPlay, printers) between the networks you choose.

### Port Forwarding

Let the internet reach one device: a game server, NAS or camera. Pick the device and a preset or ports (outside and inside can differ, ranges work), and optionally who may connect. VyGi adds the matching firewall rule, offers to reserve the device's address, and warns when the router can't be reached from the internet anyway (carrier-grade NAT, or a modem in front). Forwards made elsewhere are listed too; edit those in Advanced.

From inside your network, use the device's local address: forwards don't loop back.

### Content Filtering

- **Region blocking**: block countries, using VyOS's GeoIP firewall matching.
- **Ad and tracker blocking**: through a linked [Technitium DNS Server](https://technitium.com/dns/) (Advanced → IP → DNS Server).

### Protection

- **New-device quarantine**: on the networks you choose, a device the router hasn't seen before gets an address and can reach the router (DHCP, DNS), but nothing else, until you approve it here or on the Devices page. Turning it on approves every device the router knows at that moment (online, with a fixed IP, or in a device group), so nothing that works stops working. Approved devices are a firewall MAC group (`VYGI-KNOWN`); turning quarantine off keeps the list. Limits: devices on the same switch or Wi-Fi reach each other directly, without the router; phones with private (random) MAC addresses look new when they change it; a device that copies an approved MAC gets through.

### Intrusion Prevention

Runs [Suricata](https://suricata.io) in a container on the router, watching the ports you choose with the free Emerging Threats Open rules. Recent alerts are listed; **Block** blocks an internet address. With 24/7 watching, serious alerts become phone notifications, and **Block attackers automatically** blocks the source of a serious attack for 24 hours (local devices are never blocked). Needs about 1 GB of free memory and disk on the router, and internet access for its rules. It detects attacks; it doesn't hold traffic up to inspect it.

## Activity

### Traffic & Logs (web version)

What the 24/7 watcher recorded: internet traffic (24 hours, 7 or 30 days), **data usage** per day for all devices or one, **flows** (every connection your devices made, and every attempt one of VyGi's blocking rules stopped), and the router's system log with search.

### Changes & Backups

Every change made with VyGi in plain words ("New rule Kids bedtime"), newest first, each with **Undo**. Changes made outside VyGi are listed separately. Below them are the **backups** of the whole configuration, with what changed in each and **Restore**. See [Safety net](safety.md#undo-and-backups).

## System

### Router

- **Health Check**: problems and advice, each with an explanation and a fix. See [Safety net](safety.md#health-check).
- **Router access**: block the internet from reaching the router.
- **Router**: the setup checklist, name, time zone.
- **Updates**: VyOS updates with an automatic way back. See [Safety net](safety.md#vyos-updates).
- **Backups**.

### VyGi

- **VyGi access** (web version): the activity log, Claude, API tokens, the web password, logged-in browsers.
- **24/7 watching and alerts** (web version). See [Web server and phone app](web-server.md#247-watching).
- **Changes**: when to show a change in plain words before applying it (big changes, always, or never).

## Advanced

Every VyOS feature as Winbox-style windows: interfaces, firewall, NAT, DHCP, DNS, routes, VPN, tools like Torch and the packet sniffer, the configuration tree, and a terminal. See [Advanced](advanced.md).
