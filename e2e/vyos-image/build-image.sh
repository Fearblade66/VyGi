#!/bin/sh
# Builds the `vyos:test` Docker image from an official VyOS rolling ISO.
# Usage: ./build-image.sh [rolling-tag]   (default: the newest nightly)
set -eu
cd "$(dirname "$0")"
TAG="${1:-$(git ls-remote --tags https://github.com/vyos/vyos-nightly-build | awk -F/ '{print $3}' | grep -v '\^' | sort -V | tail -1)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Downloading VyOS $TAG ..."
curl -fsSL -o "$WORK/vyos.iso" "https://github.com/vyos/vyos-nightly-build/releases/download/$TAG/vyos-$TAG-generic-amd64.iso"
xorriso -osirrox on -indev "$WORK/vyos.iso" -extract /live/filesystem.squashfs "$WORK/fs.squashfs" >/dev/null 2>&1
rm "$WORK/vyos.iso"
unsquashfs -q -f -d "$WORK/rootfs" "$WORK/fs.squashfs" >/dev/null
tar -C "$WORK/rootfs" -c . | docker import - vyos:rolling
docker build -t vyos:test .
