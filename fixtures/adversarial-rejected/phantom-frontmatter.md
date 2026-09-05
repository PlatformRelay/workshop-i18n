---

# A slide Slidev renders as nothing

The leading separator opens no block, because the line after it is blank. But the
slide's text still begins with `---`, and Slidev's frontmatter regex closes on the
next `---` anywhere — including the one hidden inside the speaker note below.

<!--
Speaker: the dash run on the next line is invisible to the slide scanner.
---
-->
