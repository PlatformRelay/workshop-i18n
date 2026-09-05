# References and footnotes

<!-- labId: references-and-footnotes -->

A claim that needs a source.[^cve] And a second one.[^nist]

A reference-style [link to the docs][k8s-docs] and a collapsed [reference][].

An image by reference: ![the topology diagram][topology]

A shortcut link to [reference] with no second bracket pair.

[^cve]: The footnote body is prose a translator should see, but its `[^cve]` label
    is machinery — renaming it orphans the reference above.
[^nist]: A second footnote, so the corpus has more than one.

[k8s-docs]: https://kubernetes.io/docs/ "Kubernetes documentation"
[reference]: https://example.invalid/reference
[topology]: ./topology.png "Cluster topology"
