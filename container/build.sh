#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Auto-detect container runtime: prefer podman, fall back to docker
if command -v podman &>/dev/null; then
  RUNTIME=podman
elif command -v docker &>/dev/null; then
  RUNTIME=docker
else
  echo "Error: No container runtime found. Install Podman or Docker." >&2
  exit 1
fi

echo "Building NanoClaw agent container image..."
echo "Runtime: ${RUNTIME}"
echo "Image: ${IMAGE_NAME}:${TAG}"

$RUNTIME build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
