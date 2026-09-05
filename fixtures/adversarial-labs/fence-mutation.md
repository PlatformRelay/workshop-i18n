# Fence mutation

<!-- labId: fence-mutation -->

Prose before the fences.

~~~
A tilde fence containing ``` backticks and a --- separator line.
---
~~~

````md
```yaml
kind: Pod
```
````

~~~~text
~~~
nested tilde run
~~~
~~~~

```
A bare fence with no info string.
```

   ```bash
   kubectl get pods
   ```

- A fence inside a list item:

  ```yaml
  apiVersion: v1
  ---
  kind: Service
  ```

- And prose after it.

    four-space indented code block
    still code

Prose after the fences.

```bash
An unclosed fence at end of file is still skeleton.
