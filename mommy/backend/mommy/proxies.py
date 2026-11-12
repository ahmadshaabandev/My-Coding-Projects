"""The proxies whose ``X-Forwarded-For`` the app believes (uvicorn's
``--forwarded-allow-ips``), for ``MOMMY_FORWARDED_ALLOW_IPS=container-networks``
(``compose.yaml``; ``scripts/space_start.sh`` runs ``python -m mommy.proxies``).

Inside a container of a compose project, the networks the container is attached to are
the project's own: their only other members are the project's containers (the tunnel,
which forwards the visitors). They are read from the container's routing tables at start
(``/proc/net/route`` and ``/proc/net/ipv6_route``): the directly connected networks,
loopback and link-local left out.

One address of such a network is not a container: its **gateway**, the computer's side
of the network. Docker's forwarding of a published port (``127.0.0.1:8080`` in
``compose.yaml``) reaches the app from that address, and so does any program on the
computer that connects to the container directly. Trusting it would let any local
program write its own ``X-Forwarded-For`` (a fresh failure count for each guess, or
another visitor's address to lock them out). So the gateway of the default route, and
the first address of every connected network (where Docker puts a network's gateway),
are left out of the trusted networks: those requests count under the gateway's own
address.
"""

from __future__ import annotations

import ipaddress
import sys
from pathlib import Path
from typing import Iterable

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

#: ``RTF_GATEWAY`` in a ``/proc/net/route`` row's flags: the route goes through a router.
RTF_GATEWAY = 0x2
ROUTE = Path("/proc/net/route")
IPV6_ROUTE = Path("/proc/net/ipv6_route")


def _ipv4(hex_le: str) -> ipaddress.IPv4Address:
    """An address of ``/proc/net/route`` (hex, in the machine's byte order)."""
    return ipaddress.IPv4Address(int(hex_le, 16).to_bytes(4, sys.byteorder))


def read_routes(route: str | None, ipv6_route: str | None) -> tuple[list[IPNetwork], list[IPAddress]]:
    """(the directly connected networks, the default routes' gateways) of the routing
    tables' text (``/proc/net/route``, ``/proc/net/ipv6_route``; None: not available).
    Loopback, link-local and multicast networks are left out; a row that cannot be read
    is skipped."""
    nets: list[IPNetwork] = []
    gateways: list[IPAddress] = []
    for row in (route or "").splitlines()[1:]:
        col = row.split()
        if len(col) < 8 or col[0] == "lo":
            continue
        try:
            dest, gateway, flags, mask = int(col[1], 16), int(col[2], 16), int(col[3], 16), int(col[7], 16)
            if dest == 0:
                if flags & RTF_GATEWAY and gateway:
                    gateways.append(_ipv4(col[2]))
                continue
            if gateway != 0:
                continue  # a route through a router
            nets.append(ipaddress.IPv4Network((_ipv4(col[1]), bin(mask).count("1")), strict=False))
        except ValueError:
            continue
    for row in (ipv6_route or "").splitlines():
        col = row.split()
        if len(col) < 10 or col[9] == "lo":
            continue
        try:
            prefix, next_hop = int(col[1], 16), int(col[4], 16)
            if prefix == 0:
                if next_hop:
                    gateways.append(ipaddress.IPv6Address(bytes.fromhex(col[4])))
                continue
            if next_hop != 0:
                continue
            net = ipaddress.IPv6Network((bytes.fromhex(col[0]), prefix), strict=False)
        except ValueError:
            continue
        if not (net.is_link_local or net.is_multicast or net.is_loopback):
            nets.append(net)
    return nets, gateways


def _without(net: IPNetwork, addresses: Iterable[IPAddress]) -> list[IPNetwork]:
    """``net`` as CIDR blocks that leave out each of ``addresses`` it contains."""
    blocks: list[IPNetwork] = [net]
    for address in addresses:
        if address.version != net.version:
            continue
        host = ipaddress.ip_network(address)
        next_blocks: list[IPNetwork] = []
        for block in blocks:
            if address in block:
                next_blocks.extend(block.address_exclude(host))  # type: ignore[arg-type]
            else:
                next_blocks.append(block)
        blocks = next_blocks
    return sorted(blocks, key=lambda b: (b.network_address, b.prefixlen))


def trusted_networks(nets: Iterable[IPNetwork], gateways: Iterable[IPAddress]) -> tuple[list[str], list[str]]:
    """(the trusted CIDR blocks, the addresses left out): every network in ``nets``
    without the ``gateways`` it contains and without its own first address (the gateway
    Docker gives a network), when it has more than two addresses."""
    excluded: list[IPAddress] = list(dict.fromkeys(gateways))
    unique = list(dict.fromkeys(nets))
    for net in unique:
        if net.num_addresses > 2:
            first = net.network_address + 1
            if first not in excluded:
                excluded.append(first)
    blocks: list[str] = []
    for net in unique:
        blocks.extend(str(b) for b in _without(net, excluded))
    left_out = [str(a) for a in excluded if any(a in n for n in unique)]
    return list(dict.fromkeys(blocks)), left_out


def container_networks(route: str | None, ipv6_route: str | None) -> tuple[list[str], list[str]]:
    """:func:`trusted_networks` of the routing tables' text (see :func:`read_routes`)."""
    nets, gateways = read_routes(route, ipv6_route)
    return trusted_networks(nets, gateways)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii")
    except (OSError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    """``python -m mommy.proxies [container-networks]``: prints the trusted blocks,
    comma-separated, on standard output, and one line saying what they are on standard
    error; exits 1 (printing nothing on standard output) without any network."""
    args = sys.argv[1:] if argv is None else argv
    if args not in ([], ["container-networks"]):
        print("usage: python -m mommy.proxies [container-networks]", file=sys.stderr)
        return 2
    nets, gateways = read_routes(_read(ROUTE), _read(IPV6_ROUTE))
    blocks, left_out = trusted_networks(nets, gateways)
    if not blocks:
        print("space_start.sh: no network found for MOMMY_FORWARDED_ALLOW_IPS=container-networks", file=sys.stderr)
        return 1
    print(",".join(blocks))
    print(
        "space_start.sh: X-Forwarded-For is taken from the container's networks "
        + ", ".join(str(n) for n in dict.fromkeys(nets))
        + (f", except their gateways {', '.join(left_out)}" if left_out else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - the command line
    sys.exit(main())
