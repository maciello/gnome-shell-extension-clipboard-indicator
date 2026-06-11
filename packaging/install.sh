#!/usr/bin/env bash
# install.sh – Build and install gnome-shell-extension-clipboard-indicator-maciello
# and enable the self-update systemd --user timer.
#
# Usage:  bash packaging/install.sh
# Run from the repository root (or packaging/ dir; script auto-detects).
#
# What this script does:
#   1. Backs up user data (clipboard cache + dconf settings).
#   2. Builds + installs the package via makepkg -si from a temp dir.
#   3. Installs clipboard-indicator-update.sh to ~/.local/bin.
#   4. Patches the systemd .service unit with the real script path.
#   5. Installs + enables the systemd --user timer.
#   6. Prints a reminder: on Wayland you must log out and back in.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve script / repo locations
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGING_DIR="${SCRIPT_DIR}"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
readonly PKGNAME="gnome-shell-extension-clipboard-indicator-maciello"
readonly EXTENSION_UUID="clipboard-indicator@tudmotu.com"
readonly CACHE_DIR="${HOME}/.cache/${EXTENSION_UUID}"
readonly DCONF_SCHEMA="/org/gnome/shell/extensions/clipboard-indicator/"

readonly INSTALL_BIN_DIR="${HOME}/.local/bin"
readonly UPDATE_SCRIPT_DST="${INSTALL_BIN_DIR}/clipboard-indicator-update.sh"

readonly SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
readonly SERVICE_NAME="clipboard-indicator-update.service"
readonly TIMER_NAME="clipboard-indicator-update.timer"

readonly BACKUP_BASE_DIR="${HOME}/.local/share/clipboard-indicator-backups"
readonly TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
readonly BACKUP_DIR="${BACKUP_BASE_DIR}/${TIMESTAMP}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install WARNING]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[install ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Step 1: Backup user data
# ---------------------------------------------------------------------------
log "Step 1/5: Backing up user data to ${BACKUP_DIR} ..."
mkdir -p "${BACKUP_DIR}"

if [[ -d "${CACHE_DIR}" ]]; then
    log "  Copying clipboard cache: ${CACHE_DIR} -> ${BACKUP_DIR}/cache"
    cp -a "${CACHE_DIR}" "${BACKUP_DIR}/cache"
    log "  Cache backup done."
else
    warn "  Clipboard cache directory not found (${CACHE_DIR}); skipping cache backup."
fi

log "  Dumping dconf settings: ${DCONF_SCHEMA}"
if command -v dconf &>/dev/null; then
    dconf dump "${DCONF_SCHEMA}" > "${BACKUP_DIR}/settings-backup.ini" 2>/dev/null || true
    log "  dconf backup -> ${BACKUP_DIR}/settings-backup.ini"
else
    warn "  dconf not found; skipping settings backup."
fi

log "  Backup complete: ${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Step 2: Build + install via makepkg -si
# ---------------------------------------------------------------------------
log "Step 2/5: Building and installing ${PKGNAME} via makepkg ..."

# Use a temp build dir so we don't pollute the source tree.
BUILD_TMP="$(mktemp -d /tmp/clipboard-indicator-build.XXXXXX)"
trap 'rm -rf "${BUILD_TMP}"' EXIT

cp "${PACKAGING_DIR}/PKGBUILD" "${BUILD_TMP}/PKGBUILD"

cd "${BUILD_TMP}"
# makepkg -s: install missing makedepends; -i: install after build; --noconfirm: no prompts
makepkg -si --noconfirm --skippgpcheck || die "makepkg -si failed. See above for details."
log "  Package installed successfully."
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Step 3: Install update script to ~/.local/bin
# ---------------------------------------------------------------------------
log "Step 3/5: Installing update script to ${UPDATE_SCRIPT_DST} ..."
mkdir -p "${INSTALL_BIN_DIR}"
install -Dm755 "${PACKAGING_DIR}/clipboard-indicator-update.sh" "${UPDATE_SCRIPT_DST}"
log "  Update script installed."

# ---------------------------------------------------------------------------
# Step 4: Install and patch systemd units
# ---------------------------------------------------------------------------
log "Step 4/5: Installing systemd --user units ..."
mkdir -p "${SYSTEMD_USER_DIR}"

# Copy service unit and replace the placeholder with the real script path.
sed "s|__INSTALL_SH_DIR__|${INSTALL_BIN_DIR}|g" \
    "${PACKAGING_DIR}/systemd/${SERVICE_NAME}" \
    > "${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
log "  Installed ${SYSTEMD_USER_DIR}/${SERVICE_NAME} (ExecStart -> ${UPDATE_SCRIPT_DST})"

# Copy timer unit as-is.
install -Dm644 \
    "${PACKAGING_DIR}/systemd/${TIMER_NAME}" \
    "${SYSTEMD_USER_DIR}/${TIMER_NAME}"
log "  Installed ${SYSTEMD_USER_DIR}/${TIMER_NAME}"

# ---------------------------------------------------------------------------
# Step 5: Enable and start the timer
# ---------------------------------------------------------------------------
log "Step 5/5: Enabling + starting systemd --user timer ..."
systemctl --user daemon-reload
systemctl --user enable --now "${TIMER_NAME}" || \
    warn "Failed to enable/start timer. You can do it manually: systemctl --user enable --now ${TIMER_NAME}"
log "  Timer enabled."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
printf '\033[1;32m=== Installation complete ===\033[0m\n'
printf '\n'
printf '  Package : %s\n' "${PKGNAME}"
printf '  Backup  : %s\n' "${BACKUP_DIR}"
printf '  Updater : %s\n' "${UPDATE_SCRIPT_DST}"
printf '  Timer   : %s\n' "${TIMER_NAME}"
printf '\n'
printf '\033[1;33mWAYLAND NOTICE\033[0m\n'
printf '  You are running Wayland. GNOME Shell extensions are NOT hot-reloaded.\n'
printf '  You MUST log out and log back in to activate the new extension version.\n'
printf '\n'
printf '  Auto-update is set to notify-only by default.\n'
printf '  To enable automatic install (passwordless pacman rule required):\n'
printf '    export CI_AUTO_INSTALL=1  # set in ~/.config/environment.d/ to persist\n'
printf '    And add to /etc/sudoers.d/clipboard-indicator-autoupdate:\n'
printf '      %s ALL=(ALL) NOPASSWD: /usr/bin/pacman -U *\n' "$(id -un)"
printf '\n'
