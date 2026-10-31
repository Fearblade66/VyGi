# VyGi

A friendly control panel for [VyOS](https://vyos.io) routers. Set up your internet and home network, see every device, block things on a schedule, forward ports and run a VPN, without learning VyOS commands. Everything VyOS can do is still there, in Winbox-style windows, when you need it.

![Home](docs/screenshots/dashboard.png)

| | |
|---|---|
| ![Devices](docs/screenshots/clients.png) | ![Traffic Rules](docs/screenshots/traffic-rules.png) |
| **Devices**: everything on your network, live | **Traffic Rules**: block the internet or sites, on a schedule |
| ![Local Networks](docs/screenshots/networks.png) | ![Advanced](docs/screenshots/advanced.png) |
| **Local Networks**: home, guest and IoT networks | **Advanced**: every VyOS feature, Winbox-style |

## Why VyGi

- **Hard to break things.** Every change runs in Safe Mode: if it cuts you off, the router undoes it by itself. Bigger changes are shown in plain words before they're applied, and VyGi warns you before anything that would lock it out.
- **It tells you what's wrong, and fixes it.** The Health Check finds common mistakes and security holes, and shows each problem on the item it's about with a Fix button. VyOS errors are explained in plain words.
- **One step to a working router.** **Make it a router** sets up the internet, a home network, DHCP, DNS, NAT and a basic firewall together.
- **Use it your way.** It runs as a desktop app (Windows, macOS, Linux), or as a web server in Docker that you open from any browser, with an Android app. The web version can watch your routers 24/7 and send alerts to your phone.
- **Claude can help.** Connect Claude (AI) to check your setup, explain problems and make changes, always through Safe Mode.

## Quick start

1. **Run VyGi** on an always-on machine at home:
   ```
   docker compose up -d
   docker compose logs vygi
   ```
   The first command uses the [docker-compose.yml](docker-compose.yml) from this repository. The second shows the web password on first start. Open `https://<that machine>:8443` and log in.
2. **Prepare the router**: install VyOS, give it an address and turn on SSH. The welcome page shows the exact commands for your address.
3. **Connect** and follow **Set up this router**, starting with **Make it a router**.

To update later:
```
docker compose pull vygi && docker compose up -d vygi
```

Prefer a desktop app? Download it from the latest successful **Build** run under this repository's **Actions** tab.

## Documentation

- [Getting started](docs/getting-started.md): install, prepare the router, first connection
- [A tour of VyGi](docs/using-vygi.md): every page and what it's for
- [Safety net](docs/safety.md): Safe Mode, previews, Health Check, undo and backups
- [Web server and phone app](docs/web-server.md): Docker settings, 24/7 watching, alerts, Android
- [Claude (AI)](docs/claude.md)
- [Advanced](docs/advanced.md): the Winbox-style windows
- [Security](docs/security.md): how VyGi protects your routers and itself
- [Troubleshooting](docs/troubleshooting.md)
- [Limitations](docs/limitations.md)
- [Development](docs/development.md): building, testing, project layout

## License

GNU GPL v3 (see [LICENSE](LICENSE)). Credits are in [Development](docs/development.md#credits).
