#!/bin/bash
# Generate Go code from protobuf definitions

set -e

# Ensure GOPATH/bin is in PATH
export PATH="$PATH:$(go env GOPATH)/bin"

# Install protoc-gen-go and protoc-gen-go-grpc (pinned versions compatible with Go 1.23)
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.32.0
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

# Generate Go code
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       warlock.proto

echo "✅ Generated Go code from warlock.proto"
