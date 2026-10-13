#!/bin/sh
# /* AR: TeX Live, as small as the macOS install: scheme-basic plus the README's tlmgr list, which is
#    what manim's default template loads. Debian's packages would need texlive-fonts-extra (over
#    1 GB) for dsfont and calligra alone. jknapltx holds mathrsfs.sty, which BasicTeX ships and
#    scheme-basic does not. `tlmgr path add` links every program, dvisvgm included, into
#    /usr/local/bin; the installer alone links only what it installed itself.
#    Usage: install-texlive.sh [repository]   (default: mirror.ctan.org, which picks a mirror) */
set -eu

REPO="${1:-https://mirror.ctan.org/systems/texlive/tlnet}"
TEXDIR=/opt/texlive
ATTEMPTS=3
WAIT_S=5
PACKAGES="dvisvgm standalone preview babel-english doublestroke setspace tipa relsize rsfs calligra fundus-calligra
wasysym wasy ragged2e physics xcolor microtype cm-super psnfss jknapltx"

# AR: mirror.ctan.org sends each request to a random mirror, and one mid-sync can answer with a
#     truncated file. Both steps that download are safe to repeat, so they are tried again.
retry() {
    i=1
    until "$@"; do
        if [ "$i" -ge "$ATTEMPTS" ]; then
            echo "TeX Live: '$*' failed $ATTEMPTS times; giving up." >&2
            return 1
        fi
        echo "TeX Live: '$*' failed; trying again ($i/$ATTEMPTS)." >&2
        i=$((i + 1))
        sleep "$WAIT_S"
    done
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# AR: Chained with && because `set -e` does not apply inside the `until` that retry runs it in.
fetch_installer() {
    rm -rf "$work/install-tl" \
        && mkdir "$work/install-tl" \
        && wget -q -O "$work/install-tl.tar.gz" "$REPO/install-tl-unx.tar.gz" \
        && tar -xzf "$work/install-tl.tar.gz" -C "$work/install-tl" --strip-components=1
}

retry fetch_installer
cat > "$work/profile" <<PROFILE
selected_scheme scheme-basic
TEXDIR $TEXDIR
TEXMFLOCAL $TEXDIR/texmf-local
instopt_adjustpath 1
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
PROFILE
"$work/install-tl/install-tl" --profile="$work/profile" --repository "$REPO"

# AR: PACKAGES is split into words on purpose: one argument per package.
# shellcheck disable=SC2086
retry tlmgr install $PACKAGES
tlmgr path add
rm -f "$TEXDIR"/texmf-var/web2c/*.log
