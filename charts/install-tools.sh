#!/bin/sh
# Install pinned, checksummed helm, kubeconform and kind (linux/amd64) for the CI workflows.
#
#   sh charts/install-tools.sh <dir>     then put <dir> on PATH
set -eu

DEST="${1:?usage: install-tools.sh <dir>}"
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "linux/amd64 only" >&2; exit 1; }
mkdir -p "$DEST"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

get() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

get https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz \
  896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea helm.tgz
tar xzf helm.tgz linux-amd64/helm && install linux-amd64/helm "$DEST/helm"

get https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz \
  9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 kubeconform.tgz
tar xzf kubeconform.tgz kubeconform && install kubeconform "$DEST/kubeconform"

get https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 \
  aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d kind
install kind "$DEST/kind"
echo "installed helm, kubeconform and kind into $DEST"
