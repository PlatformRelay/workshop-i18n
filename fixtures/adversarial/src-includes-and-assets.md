---
slideId: adv-src-cover
layout: section-cover
image: /covers/section-99-forging.webp
src: ./shared/intro.md
kicker: Day 9
heading: Includes are machinery
---

# Includes

The `src:` key above pulls another file in; not one byte of it may move.

![](/covers/section-99-forging.webp)

Text with an inline ![badge](/img/badge.svg) reference and a [link](https://example.test/a?b=c&d=e).

<!--
Speaker: the include path and the image reference are protected skeleton.
-->

---
src: ./shared/deep-dive.md
slideId: adv-src-only
---

---
slideId: adv-src-relative
layout: statement
image: ../../assets/relative/../path.png
heading: Relative paths stay exactly as written
---

Nothing here rewrites `../../assets/relative/../path.png`.
