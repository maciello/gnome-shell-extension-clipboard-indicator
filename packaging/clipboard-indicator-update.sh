#!/usr/bin/env bash
# clipboard-indicator-update.sh
# Checks for upstream updates to gnome-shell-extension-clipboard-indicator-maciello
# and notifies the user (or auto-installs if CI_AUTO_INSTALL=1 and sudoers rule exists).
#
# Called by:  systemd --user unit clipboard-indicator-update.service
# Installed:  packaging/install.sh places this script and patches the .service unit.
#
# Auto-install behaviour (disabled by default):
#   Set CI_AUTO_INSTALL=1 in the environment AND add a passwordless pacman rule:
#     /etc/sudoers.d/clipboard-indicator-autoupdate:
#       <your-user> ALL=(ALL) NOPASSWD: /usr/bin/pacman -U *
#   Without both conditions the script only sends a desktop notification.
#   The script will NEVER silently invoke sudo without those two guards.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
readonly PKGNAME="gnome-shell-extension-clipboard-indicator-maciello"
readonly UPSTREAM_REPO="https://github.com/maciello/gnome-shell-extension-clipboard-indicator.git"
readonly CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/clipboard-indicator-updater"
readonly LOG_DIR="${HOME}/.local/share/clipboard-indicator-updater"
readonly LOGFILE="${LOG_DIR}/update.log"
readonly BUILD_DIR="${CACHE_DIR}/build"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
mkdir -p "${LOG_DIR}"
log() { printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*" >> "${LOGFILE}"; }
log "--- clipboard-indicator-update.sh started ---"

# ---------------------------------------------------------------------------
# Fetch / update local clone of the extension repo
# ---------------------------------------------------------------------------
mkdir -p "${CACHE_DIR}"
if [[ -d "${CACHE_DIR}/repo/.git" ]]; then
    log "Pulling latest commits from upstream..."
    git -C "${CACHE_DIR}/repo" fetch --tags --quiet 2>>"${LOGFILE}" || {
        log "WARNING: git fetch failed; skipping update check."
        exit 0
    }
    git -C "${CACHE_DIR}/repo" pull --ff-only --quiet 2>>"${LOGFILE}" || {
        log "WARNING: git pull failed (non-fast-forward?); continuing with cached state."
    }
else
    log "Cloning upstream repo for the first time..."
    git clone --quiet "${UPSTREAM_REPO}" "${CACHE_DIR}/repo" 2>>"${LOGFILE}" || {
        log "ERROR: git clone failed."
        exit 1
    }
fi

# ---------------------------------------------------------------------------
# Determine latest upstream version
# ---------------------------------------------------------------------------
# Use the same logic as PKGBUILD pkgver()
_latest_tag="$(git -C "${CACHE_DIR}/repo" describe --tags --long 2>/dev/null)" || true
if [[ -n "${_latest_tag}" ]]; then
    _upstream_ver="$(printf '%s' "${_latest_tag}" \
        | sed 's/^v//;s/\([^-]*\)-\([0-9]*\)-g\([0-9a-f]*\)/\1.r\2.g\3/;s/-/./g')"
else
    _commit_count="$(git -C "${CACHE_DIR}/repo" rev-list --count HEAD)"
    _short_hash="$(git -C "${CACHE_DIR}/repo" rev-parse --short HEAD)"
    _upstream_ver="0.r${_commit_count}.g${_short_hash}"
fi
log "Upstream version: ${_upstream_ver}"

# ---------------------------------------------------------------------------
# Determine installed version
# ---------------------------------------------------------------------------
_installed_ver="$(pacman -Q "${PKGNAME}" 2>/dev/null | awk '{print $2}')" || true
if [[ -z "${_installed_ver}" ]]; then
    log "Package ${PKGNAME} is not installed; nothing to update."
    exit 0
fi
log "Installed version: ${_installed_ver}"

# ---------------------------------------------------------------------------
# Compare versions (simple string compare; pacman vercmp for real ordering)
# ---------------------------------------------------------------------------
if [[ "${_upstream_ver}" == "${_installed_ver%-*}" ]] || \
   [[ "$(vercmp "${_upstream_ver}" "${_installed_ver%-*}" 2>/dev/null || echo 0)" -le 0 ]]; then
    log "Already up to date (${_installed_ver}). Nothing to do."
    exit 0
fi

log "Update available: ${_installed_ver} -> ${_upstream_ver}. Building package..."

# ---------------------------------------------------------------------------
# Build the package
# ---------------------------------------------------------------------------
mkdir -p "${BUILD_DIR}"
# Copy PKGBUILD from cached repo
cp "${CACHE_DIR}/repo/packaging/PKGBUILD" "${BUILD_DIR}/PKGBUILD"

cd "${BUILD_DIR}"
# makepkg -f: force-rebuild even if pkg already exists in PKGDIR
if ! makepkg -f --noconfirm --skippgpcheck 2>>"${LOGFILE}"; then
    log "ERROR: makepkg failed. Check ${LOGFILE} for details."
    notify-send --urgency=critical \
        "Clipboard Indicator Update Failed" \
        "makepkg failed. See ${LOGFILE} for details." 2>/dev/null || true
    exit 1
fi

# Locate the built package file
_pkg_file="$(ls -t "${BUILD_DIR}"/${PKGNAME}-*.pkg.tar.zst 2>/dev/null | head -1)"
if [[ -z "${_pkg_file}" ]]; then
    log "ERROR: built package file not found in ${BUILD_DIR}."
    exit 1
fi
log "Built package: ${_pkg_file}"

# ---------------------------------------------------------------------------
# Install or notify
# ---------------------------------------------------------------------------
_auto_install="${CI_AUTO_INSTALL:-0}"

# Check for passwordless pacman sudoers rule
_has_nopasswd=0
if sudo -n pacman --version &>/dev/null 2>&1; then
    _has_nopasswd=1
fi

if [[ "${_auto_install}" == "1" && "${_has_nopasswd}" == "1" ]]; then
    log "CI_AUTO_INSTALL=1 and passwordless pacman available. Installing..."
    if sudo pacman -U --noconfirm "${_pkg_file}" 2>>"${LOGFILE}"; then
        log "Auto-install succeeded: ${_upstream_ver}"
        notify-send --urgency=normal \
            "Clipboard Indicator Updated" \
            "Updated to ${_upstream_ver}. Log out and back in (Wayland) to reload." \
            2>/dev/null || true
    else
        log "ERROR: sudo pacman -U failed."
        notify-send --urgency=critical \
            "Clipboard Indicator Update Failed" \
            "pacman -U failed. See ${LOGFILE}." 2>/dev/null || true
        exit 1
    fi
else
    # Default: just notify; never silently sudo.
    log "Notifying user; manual install required."
    notify-send --urgency=normal \
        "Clipboard Indicator Update Available" \
        "Version ${_upstream_ver} is ready.\nRun: sudo pacman -U '${_pkg_file}'\nThen log out and back in (Wayland)." \
        2>/dev/null || true
fi

log "--- clipboard-indicator-update.sh finished ---"
