# netdash-vps: helper for a VPS

Optional. If you rent a Linux server with a public IP and connect it to your home network (WireGuard, NetBird,
Tailscale, …), netdash can manage it from the **Portfreigaben**, **VPN** and **Netzwerke** pages:

- **Port forwards** from the public IP into the home network (iptables, own chain `NETDASH-PF`). Every change is
  applied, checked and rolled back after 60 s unless netdash confirms that the VPS still answers.
- **WireGuard road-warrior tunnels**: list, start/stop, autostart, create a new tunnel with a name (next free /30 and
  port, keys and preshared key are generated) and get the client config as file and QR code.
- **Interfaces** with live rates.

The helper is one Python 3 file without dependencies. It needs `iptables`, `ip`, `wg`/`wg-quick` and systemd
(tested on Debian 12/13).

## Install

On the VPS, as root:

```sh
install -m 755 netdash-vps /usr/local/sbin/netdash-vps
mkdir -p /etc/netdash-vps
cp config.example.json /etc/netdash-vps/config.json   # then edit it
install -m 644 netdash-vps.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable netdash-vps.service   # restores the forwards at boot
```

`config.json` (every key is optional):

| Key | Default | Meaning |
|-----|---------|---------|
| `wan_ip` | source address of the default route | public address the forwards listen on |
| `dir` | `/etc/netdash-vps` | where `forwards.json` lives |
| `home_nets` | private ranges | allowed targets for port forwards |
| `wg_net` | `10.99.0.0/24` | new WireGuard tunnels get the next free /30 from here |
| `wg_first` | start of `wg_net` | skip addresses you already use by hand |
| `wg_ports` | `51820-51899` | UDP ports for new tunnels |
| `home_routes` | `home_nets` | AllowedIPs for clients that should only reach the home network |
| `dns` | none | DNS server for clients (e.g. your home resolver) |
| `name` | `VPS` | shown in client configs |

Forward targets must be reachable from the VPS through your tunnel, and the return traffic must go back the same way
(for example by masquerading on the tunnel interface).

## SSH key for netdash

On the OPNsense:

```sh
ssh-keygen -t ed25519 -N '' -C netdash-vps -f /usr/local/netdash/vps_ed25519
cat /usr/local/netdash/vps_ed25519.pub
```

On the VPS, add it to `/root/.ssh/authorized_keys` as one line, restricted to the helper:

```
command="/usr/local/sbin/netdash-vps --ssh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... netdash-vps
```

Then enter host, SSH port and user in netdash under **Einstellungen → Integrationen → VPS**.

If your provider has its own firewall in front of the VPS, open the forwarded ports and the WireGuard ports there as well.
