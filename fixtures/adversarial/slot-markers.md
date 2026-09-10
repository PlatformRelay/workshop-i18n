---
slideId: adv-slots-two-cols
layout: two-cols
heading: Two columns
---

# Left

Left column prose.

::right::

# Right

Right column prose.

---
slideId: adv-slots-interrupted
layout: two-cols
---

A paragraph Slidev splits
::right::
because the marker interrupts it.

---
slideId: adv-slots-spellings
layout: code-annotated
---

```yaml
kind: Pod
```

:: notes ::

The spaced spelling is still a marker.

::a.b-c:d_e::

So is the punctuated one.

---
slideId: adv-slots-not-markers
layout: default
---

```md
::right::
```

Inline ::right:: is prose, not a marker.

> A quote holding
> ::right::

<div>
::right::
</div>

- a bullet that continues lazily
::default::

After the lazy marker.
