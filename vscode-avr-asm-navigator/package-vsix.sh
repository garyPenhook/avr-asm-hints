#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="$(node -p "require('${ROOT_DIR}/package.json').name")"
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
PUBLISHER="$(node -p "require('${ROOT_DIR}/package.json').publisher")"
DISPLAY_NAME="$(node -p "require('${ROOT_DIR}/package.json').displayName")"
DESCRIPTION="$(node -p "require('${ROOT_DIR}/package.json').description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')")"
ENGINE="$(node -p "require('${ROOT_DIR}/package.json').engines.vscode")"
TAGS="$(node -p "(require('${ROOT_DIR}/package.json').keywords || ['avr','assembly','microchip']).join(';')")"

OUT_FILE="${ROOT_DIR}/${PUBLISHER}.${NAME}-${VERSION}.vsix"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

mkdir -p "${WORK_DIR}/extension"
rm -f "${OUT_FILE}"

PACKAGE_FILES=(
  "package.json"
  "README.md"
  "extension.js"
  "language-configuration.json"
)
PACKAGE_DIRS=(
  "syntaxes"
)

for file in "${PACKAGE_FILES[@]}"; do
  cp "${ROOT_DIR}/${file}" "${WORK_DIR}/extension/${file}"
done

for dir in "${PACKAGE_DIRS[@]}"; do
  cp -R "${ROOT_DIR}/${dir}" "${WORK_DIR}/extension/${dir}"
done

cat > "${WORK_DIR}/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="sh" ContentType="application/x-sh" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
EOF

cat > "${WORK_DIR}/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="${PUBLISHER}.${NAME}" Version="${VERSION}" Language="en-US" Publisher="${PUBLISHER}" />
    <DisplayName>${DISPLAY_NAME}</DisplayName>
    <Description xml:space="preserve">${DESCRIPTION}</Description>
    <Tags>${TAGS}</Tags>
    <Categories>Programming Languages,Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${ENGINE}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

(cd "${WORK_DIR}" && zip -q -r "${OUT_FILE}" "[Content_Types].xml" "extension.vsixmanifest" extension)
echo "Created ${OUT_FILE}"
