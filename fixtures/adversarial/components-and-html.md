---
slideId: adv-html-grid
layout: default
heading: Components everywhere
---

# A card grid

<div class="kw-cols-2 mt-3 text-sm">
  <KwCard heading="ClusterIP — the default" kind="svc">
    A stable <strong>in-cluster</strong> virtual IP. Reachable only from inside
    the cluster, and what every other type builds on.
  </KwCard>
  <KwCard heading='Say "hi" &amp; wave' kind="svc" variant="plain">
    ClusterIP <em>plus</em> a port on <code>every</code> node &lt;ns&gt;.
  </KwCard>
  <KwCard heading=Unquoted kind=pod>
    An unquoted prop, and <span class="kw-muted">(a muted aside)</span>.
  </KwCard>
</div>

---
slideId: adv-html-nested
layout: default
---

<div class="kw-cols-3 mt-4">
  <v-click at="1">
    <KwCard heading="Engine / CRI" icon="🛠️">
      What the kubelet talks to: <strong>containerd</strong> or <strong>CRI-O</strong>.
    </KwCard>
  </v-click>
  <v-click at="2">
    <KwCard heading="Runtime" kind="pod" kindVariant="labeled">
      <K8sIcon kind="pod" /> <strong>runc</strong> starts the process.
      <K8sIcon kind="sts" variant="unlabeled" size="3.4rem" class="kw-icon-stack-glyph" />
    </KwCard>
  </v-click>
</div>

<div v-click="3" class="mt-4 kw-muted text-sm">
  Page {{ $slidev.nav.currentPage }} closes the <em>runtime</em> story.
</div>

---
slideId: adv-html-notes
layout: code-annotated
---

```yaml {none|1|2}
image: web:1.4.2
imagePullPolicy: Always
```

::notes::

<CodeNote at="1" label="a real tag">
You built and named <code>demo:1</code>. That tag now points at the digest of
what you just built.
</CodeNote>

<CodeNote at="2" label="latest ≠ newest" variant="warn">
<code>latest</code> is just a tag that happens to be the default.
</CodeNote>

---
slideId: adv-html-markdown-children
layout: default
---

<KwCard heading="Blank lines make markdown">

**Markdown** children, set off by blank lines, are parsed as markdown.

- and so is a list

</KwCard>

<KwCard heading="No blank lines keep HTML">
**Not markdown** without the blank lines: the asterisks stay literal.
</KwCard>

Use the <KwChip variant="ok">core</KwChip> tier inside a plain paragraph.

<KwCard
  heading="Spread over lines"
  kind="deploy">
  A multi-line opening tag is inline HTML in a paragraph.
</KwCard>

<KwCard>
  Text around <KwChip variant="warn">a chip</KwChip> inside a card.
</KwCard>

---
slideId: adv-html-skeleton-only
layout: default
---

<div class="mt-3">
  <!-- an aside inside a block, which stays English and is reported -->
  <code>kubectl get pods</code> → ①
</div>

<style>
.kw-card { color: var(--kw-accent); }
</style>

<pre>
kubectl apply -f pod.yaml
</pre>

> <div>
> Quoted HTML text
> that wraps.
> </div>

<div>
::right::
</div>
