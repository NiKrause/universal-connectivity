package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/libp2p/go-libp2p/core/crypto"
)

func TestLoadIdentityUsesEvmPrivateKeyEnvWhenFileMissing(t *testing.T) {
	t.Setenv(identityEvmPrivateKeyEnv, "0x59c6995e998f97a5a0044966f0945382d7d5d95f993dbf3b61e64d1d4438f3f0")

	dir := t.TempDir()
	path := filepath.Join(dir, "identity.key")

	priv, err := LoadIdentity(path)
	if err != nil {
		t.Fatalf("LoadIdentity returned error: %v", err)
	}

	if priv.Type() != crypto.Secp256k1 {
		t.Fatalf("expected secp256k1 identity, got %v", priv.Type())
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected identity file to be written: %v", err)
	}
}
