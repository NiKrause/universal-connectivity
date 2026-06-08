package main

// Borrowed from https://github.com/libp2p/go-libp2p-relay-daemon/blob/master/identity.go

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"github.com/libp2p/go-libp2p/core/crypto"
)

const identityEvmPrivateKeyEnv = "GO_PEER_IDENTITY_EVM_PRIVATE_KEY"

// LoadIdentity reads a private key from the given path and, if it does not
// exist, generates a new one.
func LoadIdentity(idPath string) (crypto.PrivKey, error) {
	if _, err := os.Stat(idPath); err == nil {
		return ReadIdentity(idPath)
	} else if os.IsNotExist(err) {
		if privateKeyHex := strings.TrimSpace(os.Getenv(identityEvmPrivateKeyEnv)); privateKeyHex != "" {
			fmt.Printf("Generating secp256k1 peer identity in %s from %s\n", idPath, identityEvmPrivateKeyEnv)
			return GenerateIdentityFromEvmPrivateKey(idPath, privateKeyHex)
		}
		fmt.Printf("Generating peer identity in %s\n", idPath)
		return GenerateIdentity(idPath)
	} else {
		return nil, err
	}
}

// ReadIdentity reads a private key from the given path.
func ReadIdentity(path string) (crypto.PrivKey, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	return crypto.UnmarshalPrivateKey(bytes)
}

// GenerateIdentity writes a new random private key to the given path.
func GenerateIdentity(path string) (crypto.PrivKey, error) {
	privk, _, err := crypto.GenerateKeyPair(crypto.Ed25519, 0)
	if err != nil {
		return nil, err
	}

	bytes, err := crypto.MarshalPrivateKey(privk)
	if err != nil {
		return nil, err
	}

	err = os.WriteFile(path, bytes, 0400)

	return privk, err
}

// GenerateIdentityFromEvmPrivateKey writes a Secp256k1 libp2p private key that
// is derived directly from a 32-byte EVM private key hex string.
func GenerateIdentityFromEvmPrivateKey(path string, privateKeyHex string) (crypto.PrivKey, error) {
	normalized := strings.TrimPrefix(strings.TrimSpace(privateKeyHex), "0x")
	raw, err := hex.DecodeString(normalized)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", identityEvmPrivateKeyEnv, err)
	}

	privk, err := crypto.UnmarshalSecp256k1PrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("unmarshal secp256k1 private key from %s: %w", identityEvmPrivateKeyEnv, err)
	}

	bytes, err := crypto.MarshalPrivateKey(privk)
	if err != nil {
		return nil, err
	}

	err = os.WriteFile(path, bytes, 0400)

	return privk, err
}
