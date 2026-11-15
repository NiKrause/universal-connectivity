# Notes for agents — universal-connectivity

This fork carries the Aleph deployment path for `uc-go-peer` on top of the
upstream libp2p demo. The facts below are the ones that have cost time here.

## What `go-peer` is, and is not

It is a **circuit relay and a chat peer**. Measured 2026-08-21 against two
live deployments: a browser-shaped libp2p node gets a reservation in 1.5 s,
`/p2p-circuit/webrtc` addresses appear within about five, and a second node
connects to the first in 1.6 s — over **direct WebRTC**, with the relay used
only for signalling.

Two consequences that are easy to get backwards:

- The `relayv2.DefaultResources()` limits in `go-peer/main.go` — 2 min and
  128 KB per relayed connection — never bite for connecting, because the
  circuit is abandoned once WebRTC is up. They would bite for anything that
  keeps flowing through the relay.
- It **stores nothing**. Where data should stay available while a device is
  offline, this is the wrong relay; that is `orbitdb-relay`.

Its discovery topic is `universal-connectivity-browser-peer-discovery`, a
`const` in `go-peer/chatroom.go` — the `--room` flag only sets the chat
topic. Another app can meet peers through this relay only if it subscribes to
that topic too. A gossipsub node that has not subscribed does not forward the
payloads, which is what once left two simple-todo browsers at
`candidates: 0` and was misread as an inability to form circuits.

## The bootstrap snapshot is not a browser test

`js-peer/scripts/resolve-aleph-bootstrap.mjs` verifies relay addresses before
baking them into the site. It must not dial WebTransport or WebRTC-Direct
from Node: Node ships no WebTransport client API, and webrtc-direct fails
during the handshake even with a working `node-datachannel` binding. Those
are the addresses a browser needs **most**, so probing them here rejects
exactly the wrong ones. Prove the peer is live over a Node-dialable address
and carry the browser families through on that.

## Connecting: relay-optional by construction

Measured on 2026-08-21, written down because the wrong version of it was in the
code for months. Tracking issue:
[relay-button#119](https://github.com/NiKrause/relay-button/issues/119).

### The promise

The node stays fully functional **without** a relay. That is a guarantee, not a
default: the checkbox is off, a start without it makes no outbound network call
at all, and no relay is contacted without an explicit choice. Someone using the
app in one room leaves metadata nowhere.

A relay is a second way in, for the case the QR path cannot serve: the other
person is not here to scan anything. It is added, never substituted.

### A relay has to be asked for, and then checked

Ticking the box starts the check immediately, so the answer is measured rather
than assumed. Order matters and is not only about speed:

1. the **baked-in** addresses, probed by ping
2. **only if none answer**, Aleph discovery

That way the app talks to Aleph exactly when the known relays are silent, which
is what keeps the metadata footprint small.

### Which relay can do what

A circuit relay brokers the connection; the data then flows **directly** between
devices — measured at 1.6 s, with the relay used only for signalling. So the
2 min / 128 KB limits in go-peer's `relayv2.DefaultResources()` never bite for
connecting, and would for replication.

The real dividing line is not transport, it is **discovery**:

- **A peer you already know** — from a scanned QR code — needs only a route. Any
  circuit relay does, `uc-go-peer` included.
- **A peer you have to find** needs the relay in the mesh of your gossipsub
  discovery topic. A gossipsub node that has not subscribed to a topic does not
  forward its payloads. `uc-go-peer` subscribes to
  `universal-connectivity-browser-peer-discovery` — a `const` in
  `go-peer/chatroom.go`, not a flag.
- **Data that should be pinned** needs a relay that stores something.
  `uc-go-peer` stores nothing; only `orbitdb-relay` qualifies.

This is why a `uc-go-peer` left two simple-todo browsers at `candidates: 0`. Not
because it cannot form a circuit — it can, reservation in 1.5 s — but because it
was not on their discovery topic. Apps whose topics match it, or which also
subscribe to it, can use it among themselves.

### Do not

- Bake a relay address in and call the result server-free.
- Report "usable network" from any ICE candidate: every device has host
  candidates. Only reflexive ones say anything beyond this network answers.
- Probe several addresses of the same relay at once. libp2p muxes them onto one
  connection and the second ping fails with a stream-limit error that is
  evidence **for** reachability, not against it.
