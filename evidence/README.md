# Exact-head tag recovery QA

These screenshots were captured by the separate QA replay at plugin commit `e243a1796e8824ae75dcaabb723ca40f7eca5779`, using the exact committed `ui/bundle.js` with real React, registered plugin components and task filter, and a synthetic Kandev host adapter.

The host fixture returned 503 for shared and private tag reads on cold load. The error image shows visible Retry controls on the card and dense task-row surfaces. After Retry, the fixture returned saved `Shared saved` and `Legacy saved` values; the recovered image shows both saved chips on each surface. The replay observed zero writes and no browser page errors. This is component-level browser evidence; it does not claim a full Kandev backend/browser replay at this head.

![Cold 503 error state](tags-503-error.png)

![Saved tags after Retry](tags-recovered.png)
