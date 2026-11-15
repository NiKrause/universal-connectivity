package main

import (
	"strings"
	"testing"

	"github.com/multiformats/go-multiaddr"
)

func TestListenAddrStringsWithoutIPv6(t *testing.T) {
	addrs := listenAddrStrings("9095", "9096", "9097", false)
	for _, addr := range addrs {
		if strings.HasPrefix(addr, "/ip6/") {
			t.Fatalf("listens on IPv6 although it is disabled: %s", addr)
		}
	}
	if len(addrs) != 6 {
		t.Fatalf("want the 6 IPv4 listeners, got %d: %v", len(addrs), addrs)
	}
}

func TestListenAddrStringsWithIPv6(t *testing.T) {
	addrs := listenAddrStrings("9095", "9096", "9097", true)
	ipv6 := 0
	for _, addr := range addrs {
		if strings.HasPrefix(addr, "/ip6/::/") {
			ipv6++
		}
	}
	if len(addrs) != 12 || ipv6 != 6 {
		t.Fatalf("want 6 IPv4 and 6 IPv6 listeners, got %d (%d IPv6): %v", len(addrs), ipv6, addrs)
	}
}

func TestWithoutRawIPv6KeepsDNS6(t *testing.T) {
	var addrs []multiaddr.Multiaddr
	for _, raw := range []string{
		"/ip4/45.144.209.26/udp/37671/quic-v1",
		"/ip6/2a0f:8003:1:26:3:c226:b93d:2701/udp/37671/quic-v1",
		"/dns6/crazy-pluck-uncle-device.2n6.me/tcp/443/tls/ws",
	} {
		addrs = append(addrs, multiaddr.StringCast(raw))
	}

	got := withoutRawIPv6(addrs)
	if len(got) != 2 {
		t.Fatalf("want the IPv4 and the /dns6 address, got %v", got)
	}
	for _, addr := range got {
		if strings.HasPrefix(addr.String(), "/ip6/") {
			t.Fatalf("kept a raw IPv6 address: %s", addr)
		}
	}
}

func TestEnvFlag(t *testing.T) {
	for raw, want := range map[string]bool{"1": true, "true": true, " TRUE ": true, "0": false, "": false, "yes": false} {
		if got := envFlag(raw); got != want {
			t.Errorf("envFlag(%q) = %v, want %v", raw, got, want)
		}
	}
}
