---
slideId: adv-fences
layout: code-annotated
heading: Every way to spell a fence
---

````md magic-move
```yaml {none|1-2|all}
kind: Role
---
kind: RoleBinding
```
```yaml {1,3|2}
kind: ServiceAccount
---
kind: Secret
```
````

~~~yaml
kind: Tilde
# a bare "---" inside a tilde fence is a hard error: see adversarial-rejected/
kind: AlsoTilde
~~~

~~~~text
~~~
still inside the longer tilde fence
~~~
~~~~

```
bare fence, no info string
---
```

    four-space indented block
    ---
    still indented

- a list item with its own fence:

  ```bash {none|1|all}
  kubectl get pods -o yaml | head -20
  ```

- and a second item

```yaml
# a closing fence may be indented up to three spaces
kind: Indented
  ```

<!--
Speaker: fences are byte-identical across locales, always.
-->
