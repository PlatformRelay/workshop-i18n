#!/usr/bin/env bash
#
# Regenerate every catalog in this directory with the real GNU gettext tools.
#
# ADR 0013's acceptance bar is interoperability. The *writing* direction is discharged by
# `msgfmt` compiling our goldens. The *reading* direction cannot be discharged by fixtures
# this repository hand-wrote to imitate GNU output, however carefully — that is a
# self-consistent claim, not an interoperability fact. So every catalog here is literally
# what a GNU tool emitted, and this script is how you check that: run it, and `git diff`
# must be empty.
#
#   ./fixtures/catalogs/gnu-generated/generate.sh
#
# Requires gettext; developed against 0.23.2, and each run prints the version it used.
# Nothing in the test suite runs this — the outputs are committed so the parsing
# assertions run on machines without gettext. README.md maps each fixture to its command.
#
# The only bytes in the outputs this script writes itself are (a) the C sources xgettext
# reads, (b) the German translations, injected into one intermediate catalog and then
# re-emitted by `msgcat` so even their spelling is GNU's, and (c) four volatile timestamp
# fields pinned to fixed values so re-running is a zero-byte diff. Every structural shape
# — wrapping, fuzzy marking, `#|` previous-source, `#~` obsoletion, comment ordering — is
# the tools' own.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for tool in xgettext msginit msgmerge msgcat msgattrib msgconv msgfmt msgunfmt; do
  command -v "$tool" >/dev/null || { echo "missing $tool — install gettext" >&2; exit 1; }
done

echo "gettext: $(msgfmt --version | head -1)"

# --------------------------------------------------------------------------------------
# 1. Two generations of an English source, so msgmerge has a real edit and a real deletion
#    to react to.
# --------------------------------------------------------------------------------------

cat > "$work/src-v1.c" <<'SOURCE'
void section_pods(void) {
  /* TRANSLATORS: heading above the pod list; keep the word "Pod" untranslated. */
  puts(_("A Pod is a group of containers."));
  puts(_("A Service gives Pods a stable address."));
  puts(pgettext("slides:s02:title", "Services"));
  printf(ngettext("%d pod is running.", "%d pods are running.", n), n);
  puts(_("A Pod is the smallest deployable unit in Kubernetes, and it wraps one or more containers that share a network namespace and a set of storage volumes."));
  puts(_("Grüße, 日本語 — first line\nand a second line.\n"));
  puts(_("This unit is about to be deleted."));
}
SOURCE

# v2 rewords the first unit (-> fuzzy with #| previous-source), drops the last one
# (-> obsolete #~), and adds one nobody has translated yet.
sed -e 's/A Pod is a group of containers./A Pod is a group of one or more containers./' \
    -e 's/This unit is about to be deleted./A brand new unit nobody has translated yet./' \
    "$work/src-v1.c" > "$work/src-v2.c"

# v3 additionally drops the *fuzzy* unit, which is what makes msgmerge emit `#~|`:
# an obsolete entry that still carries its previous source.
sed -e '/A Pod is a group of one or more containers./d' "$work/src-v2.c" > "$work/src-v3.c"

extract() { # extract <source> <output> <version>
  xgettext --from-code=UTF-8 -k_ -kpgettext:1c,2 -kngettext:1,2 \
    --add-comments=TRANSLATORS \
    --package-name=workshop-i18n --package-version="$3" \
    --msgid-bugs-address=i18n@example.org \
    -o "$2" "$1"
}

( cd "$work" && extract src-v1.c v1.pot 0.1.0 && extract src-v2.c v2.pot 0.2.0 \
    && extract src-v3.c v3.pot 0.3.0 )

# --------------------------------------------------------------------------------------
# 2. Pin the volatile fields. gettext has no flag for this and ignores SOURCE_DATE_EPOCH,
#    so it is done here — and it is the only edit made to tool output. All four fields are
#    timestamps; none of them is a structural shape the codec has to read.
# --------------------------------------------------------------------------------------

pin_dates() {
  sed -i \
    -e 's/^"POT-Creation-Date: .*/"POT-Creation-Date: 2026-01-15 09:00+0000\\n"/' \
    -e 's/^"PO-Revision-Date: .*/"PO-Revision-Date: 2026-01-15 10:30+0000\\n"/' \
    -e 's/^# Copyright (C) [0-9]* /# Copyright (C) 2026 /' \
    -e 's/^# Automatically generated, [0-9]*\./# Automatically generated, 2026./' \
    "$1"
}

pin_dates "$work/v1.pot"; pin_dates "$work/v2.pot"; pin_dates "$work/v3.pot"

msginit --no-translator --locale=de_DE.UTF-8 --input="$work/v1.pot" --output-file="$work/de-v1.po"
pin_dates "$work/de-v1.po"

# --------------------------------------------------------------------------------------
# 3. The translator's contribution. This is the one place a human supplies content; the
#    result is immediately re-emitted by `msgcat`, so even the byte layout is GNU's.
# --------------------------------------------------------------------------------------

python3 - "$work/de-v1.po" "$work/de-v1-raw.po" <<'TRANSLATE'
import sys

text = open(sys.argv[1], encoding='utf-8').read()

for source, target in [
    ('A Pod is a group of containers.', 'Ein Pod ist eine Gruppe von Containern.'),
    ('A Service gives Pods a stable address.', 'Ein Service gibt Pods eine stabile Adresse.'),
    ('Services', 'Dienste'),
    ('This unit is about to be deleted.', 'Diese Einheit wird gleich gelöscht.'),
]:
    text = text.replace(
        'msgid "%s"\nmsgstr ""' % source,
        'msgid "%s"\nmsgstr "%s"' % (source, target),
    )

text = text.replace(
    'msgstr[0] ""\nmsgstr[1] ""',
    'msgstr[0] "%d Pod läuft."\nmsgstr[1] "%d Pods laufen."',
)
text = text.replace(
    '"more containers that share a network namespace and a set of storage volumes."\nmsgstr ""',
    '"more containers that share a network namespace and a set of storage volumes."\n'
    'msgstr ""\n'
    '"Ein Pod ist die kleinste in Kubernetes einsetzbare Einheit und umschließt einen "\n'
    '"oder mehrere Container, die sich einen Netzwerk-Namensraum und eine Menge von "\n'
    '"Speicher-Volumes teilen."',
)
text = text.replace(
    '"and a second line.\\n"\nmsgstr ""',
    '"and a second line.\\n"\nmsgstr ""\n"Grüße, 日本語 — erste Zeile\\n"\n"und eine zweite Zeile.\\n"',
)

# A translator comment and a flag on the unit v2 deletes, so the obsolete entry msgmerge
# writes carries the shapes GNU keeps on `#~` blocks (unprefixed `#` and `#,` lines).
text = text.replace(
    '#: src-v1.c:9\nmsgid "This unit is about to be deleted."',
    '# Translator note: wording taken from the 2024 glossary.\n'
    '#: src-v1.c:9\n#, no-c-format\nmsgid "This unit is about to be deleted."',
)

open(sys.argv[2], 'w', encoding='utf-8').write(text)
TRANSLATE

msgcat -o "$work/de-v1-tr.po" "$work/de-v1-raw.po"
msgfmt --check --statistics -o /dev/null "$work/de-v1-tr.po"

# --------------------------------------------------------------------------------------
# 4. The fixtures.
# --------------------------------------------------------------------------------------

emit() { echo "  $1"; }

# The flagship: one msgmerge run producing fuzzy + `#|` previous-source, an obsolete `#~`
# entry keeping its translation, plurals, msgctxt, a c-format flag, `#.` extracted and
# `#:` reference comments, GNU column wrapping, embedded newlines and non-ASCII.
msgmerge --previous -o "$here/msgmerge-previous.po" "$work/de-v1-tr.po" "$work/v2.pot"
emit msgmerge-previous.po

# Obsoleting an entry that was itself fuzzy: `#~|` previous-source on an obsolete entry,
# plus the `#`/`#,` lines GNU writes *unprefixed* in front of a `#~` block.
msgmerge --previous -o "$here/msgmerge-obsolete-previous.po" \
  "$here/msgmerge-previous.po" "$work/v3.pot"
emit msgmerge-obsolete-previous.po

# The wrapping shapes: GNU's own "no wrapping" (the closest thing to our canonical form),
# and an absurd column so an entry wraps mid-word on nearly every line.
msgcat --no-wrap -o "$here/msgcat-no-wrap.po" "$here/msgmerge-previous.po"
emit msgcat-no-wrap.po
msgcat --width=20 -o "$here/msgcat-width20.po" "$here/msgmerge-previous.po"
emit msgcat-width20.po

# Every non-ASCII character as an octal *byte* escape, split across continuation lines —
# the case parse.ts concatenates adjacent strings before unescaping in order to survive.
msgcat --escape -o "$here/msgcat-escape.po" "$here/msgmerge-previous.po"
emit msgcat-escape.po

# Indented style: continuation lines and keywords carry leading whitespace.
msgcat --indent -o "$here/msgcat-indent.po" "$here/msgmerge-previous.po"
emit msgcat-indent.po

# A header plus nothing but obsolete entries.
msgattrib --only-obsolete -o "$here/msgattrib-only-obsolete.po" \
  "$here/msgmerge-obsolete-previous.po"
emit msgattrib-only-obsolete.po

# A round trip through the binary catalog: no comments, no flags, no obsolete entries, and
# a header gettext rebuilt rather than copied.
msgfmt -o "$work/de.mo" "$here/msgmerge-previous.po"
msgunfmt -o "$here/msgunfmt.po" "$work/de.mo"
emit msgunfmt.po

# Two catalogs disagreeing about one translation: msgcat writes both into the msgstr,
# separated by its `#-#-#-#-#` conflict markers, and marks the entry fuzzy.
sed 's/Ein Service gibt Pods eine stabile Adresse./Ein Dienst gibt Pods eine feste Adresse./' \
  "$here/msgmerge-previous.po" > "$work/de-v2-alt.po"
msgcat -o "$here/msgcat-conflict.po" "$here/msgmerge-previous.po" "$work/de-v2-alt.po"
emit msgcat-conflict.po

# Escaping xgettext had to encode itself, written without column wrapping so the file is
# in exactly the shape our serializer produces.
cat > "$work/src-hostile.c" <<'SOURCE'
void hostile(void) {
  puts(_("He said \"hello\" - loudly."));
  puts(_("Windows path: C:\\srv\\data\\"));
  puts(_("tab\there and a really quite long sentence that gettext would certainly want to wrap somewhere near column seventy-seven."));
  puts(_("trailing newline\n"));
}
SOURCE
( cd "$work" && xgettext --from-code=UTF-8 -k_ -o hostile.pot src-hostile.c )
pin_dates "$work/hostile.pot"
# Every msgid here is ASCII, so xgettext leaves the placeholder `charset=CHARSET`; msgconv
# settles it rather than leaving a fixture msgfmt has to warn about.
msgconv --to-code=UTF-8 -o "$work/hostile-utf8.pot" "$work/hostile.pot"
msgcat --no-wrap -o "$here/xgettext-hostile-no-wrap.po" "$work/hostile-utf8.pot"
emit xgettext-hostile-no-wrap.po

# --------------------------------------------------------------------------------------
# 5. GNU output this codec refuses. Kept as fixtures precisely because they are valid
#    gettext: the refusal is a deliberate limit, and it is pinned so it cannot drift into
#    an accident. See README.md in this directory and ADR 0013.
# --------------------------------------------------------------------------------------

mkdir -p "$here/refused"

( cd "$work" && xgettext --from-code=UTF-8 -k_ -kpgettext:1c,2 -kngettext:1,2 \
    --add-comments=TRANSLATORS --omit-header \
    -o "$here/refused/xgettext-omit-header.po" src-v2.c 2>/dev/null )
emit refused/xgettext-omit-header.po

# Headerlessness propagates: msgmerge takes the header from its definition file, so a
# headerless definition yields a headerless merge even against a POT that has one.
msgmerge --previous -o "$here/refused/msgmerge-headerless.po" \
  "$here/refused/xgettext-omit-header.po" "$work/v2.pot" 2>/dev/null
emit refused/msgmerge-headerless.po

echo "done."
