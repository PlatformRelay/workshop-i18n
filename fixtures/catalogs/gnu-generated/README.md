# Catalogs the GNU gettext tools wrote

Every `.po` file in this directory is byte-for-byte what a GNU gettext tool emitted. None
of them was hand-written, and none of them was hand-edited afterwards.

That distinction is the whole point. ADR 0013 makes interoperability the acceptance bar
for owning the PO codec, and the two directions are not discharged the same way:

- **Writing** is evidenced by `msgfmt` compiling our own goldens
  (`packages/catalog-po/test/msgfmt.test.ts`). The reference reader accepts what we write.
- **Reading** cannot be evidenced by a fixture we wrote to *imitate* GNU output. However
  carefully `../gnu-wrapped.po` reproduces GNU column wrapping, "we read GNU wrapping
  correctly" stays a self-consistent claim about our own authorship rather than a fact
  about gettext. These files close that gap: the tools produced them, and
  `packages/catalog-po/test/gnu-fixtures.test.ts` asserts the codec reads them.

Generated with **GNU gettext 0.23.2** by [`generate.sh`](./generate.sh). Re-run it and
`git diff` must be empty; that is how the provenance stays checkable rather than asserted.

```sh
./fixtures/catalogs/gnu-generated/generate.sh
```

The script builds two generations of a C source, extracts both with `xgettext`, has a
translator fill in the German, and then lets the tools do everything structural. The only
bytes it writes into the outputs itself are four timestamp fields, pinned so a re-run is a
zero-byte diff — read the script's header comment for the exact scope of that.

## What each file is, and what it covers

`$WORK` below is the script's temporary directory; the translated v1 catalog in it is
`msginit` output with German filled in and re-emitted by `msgcat`.

| File | Command | Shapes it covers |
| --- | --- | --- |
| `msgmerge-previous.po` | `msgmerge --previous de-v1-tr.po v2.pot` | fuzzy entry with `#\|` previous-source; obsolete `#~` entry keeping its translation; plural forms; `msgctxt`; `c-format` and `no-c-format` flags; `#.` extracted and `#:` reference comments; GNU column wrapping; embedded newlines; non-ASCII |
| `msgmerge-obsolete-previous.po` | `msgmerge --previous msgmerge-previous.po v3.pot` | `#~\|` — previous-source on an *obsolete* entry — and the unprefixed `#` / `#,` lines GNU writes in front of a `#~` block |
| `msgcat-no-wrap.po` | `msgcat --no-wrap msgmerge-previous.po` | GNU's own unwrapped spelling; the closest shape to our canonical form, so the only remaining delta is entry order |
| `msgcat-width20.po` | `msgcat --width=20 msgmerge-previous.po` | wrapping at an absurd column: nearly every string continues across many adjacent literals |
| `msgcat-escape.po` | `msgcat --escape msgmerge-previous.po` | every non-ASCII character as an octal *byte* escape, split across continuation lines — the case `parse.ts` concatenates adjacent strings before unescaping in order to survive |
| `msgcat-indent.po` | `msgcat --indent msgmerge-previous.po` | indented style: keywords and continuation lines carry leading whitespace |
| `msgcat-conflict.po` | `msgcat msgmerge-previous.po de-v2-alt.po` | two catalogs disagreeing about one translation: msgcat writes both into the `msgstr` behind its `#-#-#-#-#` markers and marks the entry fuzzy |
| `msgattrib-only-obsolete.po` | `msgattrib --only-obsolete msgmerge-obsolete-previous.po` | a header followed by nothing but obsolete entries |
| `msgunfmt.po` | `msgfmt -o de.mo msgmerge-previous.po && msgunfmt de.mo` | a round trip through the *binary* catalog: no comments, no flags, no obsolete entries, and a header gettext rebuilt rather than copied |
| `xgettext-hostile-no-wrap.po` | `xgettext --from-code=UTF-8 -k_`, then `msgconv --to-code=UTF-8`, then `msgcat --no-wrap` | escaping xgettext had to encode itself — embedded `"`, a trailing `\`, a tab, a trailing newline — in the unwrapped shape our serializer produces |

## `refused/` — valid GNU output this codec rejects

The files under `refused/` are **not malformed**. `msgfmt` compiles both. The codec
refuses them anyway, and that refusal is pinned by a test so it cannot drift from a
decision into an accident.

| File | Command | Why the codec refuses it |
| --- | --- | --- |
| `refused/xgettext-omit-header.po` | `xgettext … --omit-header src-v2.c` | no header entry — `parsePo` requires the catalog to start with `msgid ""` |
| `refused/msgmerge-headerless.po` | `msgmerge --previous refused/xgettext-omit-header.po v2.pot` | same: headerlessness propagates, because `msgmerge` takes the header from its definition file |

This is a real limit, not a hypothetical one, and it is kept on purpose: the header is
where `Content-Type` and `Plural-Forms` live, so a headerless catalog has an undeclared
encoding — which is why gettext's own tools emit `invalid multibyte sequence` on these
files, and why `msgen` synthesizes a header rather than propagating its absence. Nothing
in this tool's own pipeline can produce one, because `extract` always writes a header.

So the parser refuses, and its message carries the way out rather than only the rule:

```
<file>:1: catalog does not start with a header entry (msgid ""), so its encoding and
plural rules are undeclared — synthesize one with `msginit` or `msgen`, or re-export the
catalog from your TMS with its header (`--omit-header` output is a template for diffing,
not a catalog to ship)
```

Note what the rule is *not*. It is written as "the header must be first", but no GNU tool
can trip it that way: `--sort-output`, `--sort-by-file` and `msgattrib --set-obsolete` all
leave `msgid ""` at the top, because gettext treats the header as a distinguished entry
rather than as a message. Every GNU catalog that reaches the error has no header at all.
See ADR 0013 for the full reasoning.
