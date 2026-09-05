---
slideId: adv-yaml-quoting
layout: comparison
leftHeading: Plain scalar heading
rightHeading: 'Single quoted with an '' escape'
leftBadge: "Double \"quoted\" badge"
rightBadge: 'colon: inside a quoted value'
story: |
  A literal block scalar
  across two lines.
next: >
  A folded block scalar
  joined into one line.
duration: 40 min
day: Day 3
section: '18'
clicks: 3
zoom: 0.82
compact: true
class: kw-cmp-compact
---

# Quoting styles

Every one of those values is prose; every key below it is machinery.

---
slideId: adv-yaml-nonscalar
layout: default
heading:
  - a list where text was declared
kicker: 42
---

A declared text key holding a list or a number stays English.

<!--
Speaker: over-extracting a layout switch breaks the build in one locale only.
-->
