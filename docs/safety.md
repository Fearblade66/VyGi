# Safety net

[← Documentation](../README.md#documentation)

A router is easy to cut yourself off from. VyGi has several layers so a mistake costs you a few minutes, not a trip to the router's console.

## Safe Mode

On by default (top bar). Every change is applied with VyOS's `commit-confirm`: after a change, VyGi shows **Confirm (m:ss)**. Check that everything still works, then press it. If you don't (because the change cut you off, or you walked away), the router undoes the change when the countdown ends.

- The countdown length is next to the switch (1 to 10 minutes).
- VyOS's default way of undoing is to **restart** the router. VyGi offers to change it to **reload** the old settings instead, which is much quicker. The Health Check flags it too.
- VyOS allows one pending change at a time. If one is waiting from another VyGi window, the command line or another person, VyGi asks whether to keep it. It never confirms someone else's change behind your back.
- A few changes can't use Safe Mode (VyOS restarts its own API for them), such as limiting which addresses may use the API. VyGi says so and makes sure those can't lock it out.

## Saving

Changes are live right away but are lost when the router restarts, until they're saved. **Save changes automatically** (on by default, in the account menu) saves after each confirmed change. Without it, **Save** in the top bar turns red while something is unsaved, and VyGi asks before you disconnect.

## Before a change is applied

- **Preview**: changes that touch several things are first shown in plain words (Add / Change / Remove / Turn on / Turn off, what, which page owns it), with the VyOS commands folded underneath. System → VyGi → Changes sets this to always or never. **Make it a router** always shows it.
- **Conflict check**: VyGi checks what new problems a change would cause, such as two networks overlapping or a port forward into a network without internet. If the fix only touches VyGi's own settings, it's offered as "VyGi will also change these" (ticked, you confirm). Anything else is shown as "Worth knowing" and left to you.
- **Lockout check**: a change that would take away the address VyGi reaches the router on, the login or SSH key VyGi uses, or that would forward VyGi's own connection somewhere else, gets a clear warning first.
- **Hand-made settings are left alone.** Settings made in Advanced, on the command line or by Claude are never changed automatically. Fixing them from the Health Check shows the exact commands and asks first.

## When a change fails

- **Errors in plain words**: when VyOS refuses a change, VyGi explains what it means and what to do, with VyOS's own message under it.
- **No half-applied changes**: VyOS applies a change section by section, so a failure can leave earlier parts applied. VyGi checks afterwards and puts back the settings from just before.

## Health Check

System → Router, and on Home when something needs attention. Problems also show on the item they're about (a network, port forward, VPN server, the internet connection), with the same Fix button.

It looks for:

- **Mistakes**: networks that overlap; DHCP pools outside their network or containing the router's own address; two devices with the same fixed address; a network without internet (no NAT) or without working DNS; firewall rules that drop replies; the same port forwarded twice; a forward to an address that can change, into a network without internet, or with no port at all (that takes every connection, including VyGi's); a VPN port that's closed; speed limits or schedules that offloading defeats; leftovers from deleted VyGi settings.
- **Security**: VyOS running from the installer (nothing survives a restart); a nightly build; logins still using the password "vyos" (checked on the router, so hashes never leave it); the router reachable from the internet; devices reachable over IPv6; DNS answering anyone; the API open to every address; a short API key; SSH without guessing protection; Safe Mode restarting instead of reloading.
- **Router state**: unsaved changes, ports without a cable, disk, memory, load, recent errors in the log.

A router whose internet address is private (another router in front of it) gets advice instead of a problem for its open internet side: the internet only reaches it through what that router forwards.

## Undo and backups

- **Undo** (Activity → Changes & Backups): every change made with VyGi, in plain words, with **Undo**. Undo puts the router back to how it was before that change, through Safe Mode, and lists any later changes that get undone with it.
- **Backups**: VyGi saves the whole configuration each time you connect and it changed (the last 30 per router). The 24/7 server also checks every 6 hours, so changes made outside VyGi are kept too. Each backup shows what changed; **Restore** loads it through Safe Mode. A backup much smaller than the one before it is marked, since it's likely a router that lost its settings.
- **Revisions** (Advanced → System → Revisions): VyOS's own commit history, with a diff and rollback to any revision without restarting.
- **VyGi's own login survives a restore.** Restoring settings from before VyGi had its own login keeps that login, so a restore can't lock VyGi out.

## When the router won't answer

When the API doesn't answer, VyGi tries SSH and tells you which it is: the router isn't reachable at all, or only its API is off. You get a button to turn the API back on over SSH, or to restore a backup over SSH. The second is for a router that restarted without its settings: VyGi copies the backup over, loads it and saves it.

## VyOS updates

System → Router → Updates checks for a new VyOS version. **Update now** saves the settings, installs the new version next to the current one, and asks before restarting.

**Automatic way back**: before restarting, VyGi leaves a small script on the router. When the new version starts, it waits 10 minutes for VyGi to reach it (the 24/7 watcher, or any VyGi window). If nothing does, the router switches back to the old version and restarts into it, and VyGi tells you when it reconnects. A new version that's reachable but broken in some other way stays; **Go back…** under Updates restarts into the previous version.
