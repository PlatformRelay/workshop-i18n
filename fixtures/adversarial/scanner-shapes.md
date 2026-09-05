---
slideId: adv-scanner-comment
layout: statement
heading: A separator inside a speaker note
---

# Welcome

<!--
Speaker: remember the two clusters.

---

Then move on to the demo — the line above is prose, not a slide break.
-->

---
slideId: adv-scanner-inline-comment
layout: statement
heading: Comments that open and close on one line
---

An aside <!-- not a note --> sits mid-sentence.

<!-- one --> and <!-- two --> on the same line.

<!--
Speaker: only this trailing comment is the note.
-->

---
slideId: adv-scanner-indented-fence
layout: code-annotated
heading: A fence indented past four spaces
---

Text before.

      ```yaml
      kind: Deployment
      ```

Text after.

<!--
Speaker: Slidev trims leading whitespace before looking for a fence.
-->
