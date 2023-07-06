#!/bin/bash
mkdir -p lib/sops-layer

FILE=lib/sops-layer/sops

if [ -f "$FILE" ]; then
    echo "✅ Found sops at $FILE. Skipping download."
    exit 0;
fi

echo "🟢 Downloading sops binary"
curl -L https://github.com/mozilla/sops/releases/download/v3.7.2/sops-v3.7.2.linux -o $FILE
chmod a+x lib/sops-layer/sops.linux
echo "✅ Successfully downloaded sops to $FILE!"