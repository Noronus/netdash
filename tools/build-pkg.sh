#!/bin/sh
# Build the OPNsense packages and the pkg repository. Runs on FreeBSD (same major version as OPNsense).
#   tools/build-pkg.sh VERSION OUTDIR [SIGNING_KEY.pem]
# Needs frontend/dist (npm run build). Output:
#   OUTDIR/repo/            pkg repository (meta.conf, packagesite.pkg, data.pkg, All/*.pkg)
#   OUTDIR/os-netdash-repo.pkg   bootstrap package: adds this repository to OPNsense
set -eu
VER=${1:?version}
OUT=${2:?outdir}
KEY=${3:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
URL=${REPO_URL:-https://noronus.github.io/netdash/repo}
MAINT="74186111+Noronus@users.noreply.github.com"
WWW="https://github.com/Noronus/netdash"
[ -f "$ROOT/frontend/dist/index.html" ] || { echo "frontend/dist missing, run npm run build" >&2; exit 1; }

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$OUT/repo/All"

manifest() {  # name comment desc scripts-ucl
	cat <<M
name: "$1"
version: "$VER"
origin: "opnsense/$1"
comment: "$2"
desc: "$3"
maintainer: "$MAINT"
www: "$WWW"
prefix: "/usr/local"
categories: ["sysutils"]
licenselogic: "single"
licenses: ["MIT"]
$4
M
}

plist() { echo "@owner root"; echo "@group wheel"; (cd "$1" && find . -type f | sed 's|^\./|/|' | sort) }

# ---------------------------------------------------------------- os-netdash
S=$W/netdash
mkdir -p "$S/usr/local/netdash/app" "$S/usr/local/netdash/www"
cp "$ROOT"/backend/*.py "$ROOT"/backend/auth.php "$S/usr/local/netdash/app/"
sed -i '' "s/^VERSION = .*/VERSION = \"$VER\"/" "$S/usr/local/netdash/app/main.py"
cp -R "$ROOT/frontend/dist/" "$S/usr/local/netdash/www/"
cp -R "$ROOT/plugin/src/" "$S/usr/local/"
chmod 755 "$S/usr/local/etc/rc.d/netdash"
plist "$S" > "$W/netdash.plist"
manifest os-netdash "Network dashboard and settings board for OPNsense" \
	"Devices with traffic and DNS, network map, firewall rules and live log, reverse proxy with DNS rewrite, services, WireGuard, diagnostics. Optional integrations: AdGuard Home, UniFi, Gatus, Unraid, Realtek web switches, NetBird, a Linux VPS." \
	'scripts: {
  post-install: "[ -f /usr/local/etc/netdash.conf ] || cp /usr/local/etc/netdash.conf.sample /usr/local/etc/netdash.conf\nmkdir -p /usr/local/netdash/data && chmod 700 /usr/local/netdash\necho netdash_enable=\"YES\" > /etc/rc.conf.d/netdash\nif [ -f /usr/local/etc/rc.d/configd ]; then /usr/local/etc/rc.d/configd restart; fi\nif [ -f /usr/local/etc/rc.configure_plugins ]; then /usr/local/etc/rc.configure_plugins POST_INSTALL; fi\nrm -f /var/lib/php/tmp/opnsense_menu_cache.xml /var/lib/php/tmp/opnsense_acl_cache.json\n/usr/local/etc/rc.d/netdash stop >/dev/null 2>&1 || true\n/usr/local/etc/rc.d/netdash start",
  pre-deinstall: "/usr/local/etc/rc.d/netdash stop >/dev/null 2>&1 || true",
  post-deinstall: "[ -f /usr/local/etc/rc.d/netdash ] || rm -f /etc/rc.conf.d/netdash\nif [ -f /usr/local/etc/rc.d/configd ]; then /usr/local/etc/rc.d/configd restart; fi\nif [ -f /usr/local/etc/rc.configure_plugins ]; then /usr/local/etc/rc.configure_plugins POST_DEINSTALL; fi\nrm -f /var/lib/php/tmp/opnsense_menu_cache.xml /var/lib/php/tmp/opnsense_acl_cache.json"
}' > "$W/netdash.ucl"
pkg create -M "$W/netdash.ucl" -p "$W/netdash.plist" -r "$S" -o "$OUT/repo/All"

# ---------------------------------------------------------------- os-netdash-repo
R=$W/repo
mkdir -p "$R/usr/local/etc/pkg/repos"
if [ -n "$KEY" ]; then
	# pkg repo signs with the RSA key; clients check that signature against this public key
	mkdir -p "$R/usr/local/etc/pkg/keys"
	openssl rsa -in "$KEY" -pubout -out "$R/usr/local/etc/pkg/keys/netdash.pub" 2>/dev/null
	SIG='signature_type: "pubkey",
  pubkey: "/usr/local/etc/pkg/keys/netdash.pub",'
else
	SIG='signature_type: "none",'
fi
cat > "$R/usr/local/etc/pkg/repos/netdash.conf" <<C
netdash: {
  url: "$URL",
  $SIG
  priority: 5,
  enabled: yes
}
C
plist "$R" > "$W/repo.plist"
manifest os-netdash-repo "Package repository for os-netdash" \
	"Adds the netdash package repository, so os-netdash shows up under System > Firmware > Plugins." "" > "$W/repo.ucl"
pkg create -M "$W/repo.ucl" -p "$W/repo.plist" -r "$R" -o "$OUT/repo/All"
cp "$OUT/repo/All/os-netdash-repo-$VER.pkg" "$OUT/os-netdash-repo.pkg"

# ---------------------------------------------------------------- catalog
if [ -n "$KEY" ]; then pkg repo "$OUT/repo" "$KEY"; else pkg repo "$OUT/repo"; fi
ls -la "$OUT" "$OUT/repo" "$OUT/repo/All"
