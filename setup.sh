#!/bin/bash
set -e

echo "🔧 Setting up Classroom Screen Share..."

# Install dependencies
echo "📦 Installing npm packages..."
npm install

# Generate self-signed SSL certs (WebRTC requires HTTPS)
CERT_DIR="./certs"
if [ ! -f "$CERT_DIR/key.pem" ]; then
  echo "🔐 Generating self-signed SSL certificates..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 365 -nodes -subj "/CN=localhost"
  echo "✅ Certificates generated in $CERT_DIR/"
else
  echo "✅ Certificates already exist in $CERT_DIR/"
fi

echo ""
echo "✅ Setup complete! Run: npm start"
echo "   Presenter: https://YOUR_IP:3101/present"
echo "   Viewer:    https://YOUR_IP:3101/view/CODE"
