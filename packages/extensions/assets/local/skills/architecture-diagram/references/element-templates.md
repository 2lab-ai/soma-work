# Element Templates

Copy-paste JSON templates for each Excalidraw element type. The `strokeColor` and `backgroundColor` values are placeholders — always pull actual colors from `color-palette.md` based on the element's semantic purpose.

## Free-Floating Text (no container)
```json
{
  "type": "text",
  "id": "label1",
  "x": 100, "y": 100,
  "width": 200, "height": 25,
  "text": "Section Title",
  "originalText": "Section Title",
  "fontSize": 20,
  "fontFamily": 3,
  "textAlign": "left",
  "verticalAlign": "top",
  "strokeColor": "<title color from palette>",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 11111,
  "version": 1,
  "versionNonce": 22222,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "containerId": null,
  "lineHeight": 1.25
}
```

## Line (structural, not arrow)
```json
{
  "type": "line",
  "id": "line1",
  "x": 100, "y": 100,
  "width": 0, "height": 200,
  "strokeColor": "<structural line color from palette>",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 44444,
  "version": 1,
  "versionNonce": 55555,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "points": [[0, 0], [0, 200]]
}
```

## Small Marker Dot
```json
{
  "type": "ellipse",
  "id": "dot1",
  "x": 94, "y": 94,
  "width": 12, "height": 12,
  "strokeColor": "<marker dot color from palette>",
  "backgroundColor": "<marker dot color from palette>",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 66666,
  "version": 1,
  "versionNonce": 77777,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false
}
```

## Rectangle
```json
{
  "type": "rectangle",
  "id": "elem1",
  "x": 100, "y": 100, "width": 180, "height": 90,
  "strokeColor": "<stroke from palette based on semantic purpose>",
  "backgroundColor": "<fill from palette based on semantic purpose>",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 12345,
  "version": 1,
  "versionNonce": 67890,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": [{"id": "text1", "type": "text"}],
  "link": null,
  "locked": false,
  "roundness": {"type": 3}
}
```

## Text (centered in shape)
```json
{
  "type": "text",
  "id": "text1",
  "x": 130, "y": 132,
  "width": 120, "height": 25,
  "text": "Process",
  "originalText": "Process",
  "fontSize": 16,
  "fontFamily": 3,
  "textAlign": "center",
  "verticalAlign": "middle",
  "strokeColor": "<text color — match parent shape's stroke or use 'on light/dark fills' from palette>",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 11111,
  "version": 1,
  "versionNonce": 22222,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "containerId": "elem1",
  "lineHeight": 1.25
}
```

## Arrow
```json
{
  "type": "arrow",
  "id": "arrow1",
  "x": 282, "y": 145, "width": 118, "height": 0,
  "strokeColor": "<arrow color — typically matches source element's stroke from palette>",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 33333,
  "version": 1,
  "versionNonce": 44444,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false,
  "points": [[0, 0], [118, 0]],
  "startBinding": {"elementId": "elem1", "focus": 0, "gap": 2},
  "endBinding": {"elementId": "elem2", "focus": 0, "gap": 2},
  "startArrowhead": null,
  "endArrowhead": "arrow"
}
```

For curves: use 3+ points in `points` array.

---

## Canonical Archetypes

The elements above are the building blocks. Below are five archetype skeletons — starting points, not copy-paste JSON. When the user's request maps cleanly to one of these, begin from that layout and specialize. Each entry gives: one-line description, relative layout hint, and a selection guide.

### (a) 3-tier Web App

- **Description:** Classic browser → app server → database, optionally fronted by a CDN and backed by a cache.
- **Components:** Frontend (cyan) · Backend API (emerald) · Database (violet). Optional: CDN (amber, left of Frontend), Cache (violet, between Backend and DB).
- **Layout hint:** left → right flow. Frontend on the far left, Database on the far right. CDN/Cache sit inline as pass-throughs.
- **Arrows:** request flow left → right (Frontend → Backend → DB). No cross-tier arrows.
- **Use when:** user describes a single web product, SaaS MVP, or any "simple full-stack" diagram.

### (b) Event-driven

- **Description:** Producers emit events into a bus; one or more consumers read and act on them, with a dead-letter queue for failures.
- **Components:** Producer (emerald) · Message Bus (orange, center) · Consumer(s) (emerald) · DLQ (rose, below the bus). Often a Database (violet) behind each consumer.
- **Layout hint:** bus in the center. Producers on the left fanning in; consumers on the right fanning out. DLQ sits directly below the bus with a dashed or rose-stroked arrow from each consumer.
- **Arrows:** producer → bus → consumer (left-to-right). Consumer → DLQ (downward, labeled "on failure").
- **Use when:** user mentions Kafka, SQS, RabbitMQ, NATS, event sourcing, pub/sub, or "async processing".

### (c) ML Pipeline

- **Description:** Data flows from source through ingest, a feature store, training, a model registry, and finally serving — with a client at the end.
- **Components:** Data Source (slate external) · Ingest (emerald) · Feature Store (violet) · Training (emerald) · Model Registry (violet) · Serving (emerald) · Client (cyan).
- **Layout hint:** long left → right chain. Keep Training and Model Registry stacked vertically to make the "train → register → serve" loop legible. The Serving box sits horizontally between Model Registry and Client.
- **Arrows:** straight left-to-right chain. Add a back-edge from Serving → Feature Store if the user mentions online features.
- **Use when:** user describes a model-training workflow, MLOps diagram, or inference platform.

### (d) Multi-region

- **Description:** Two (or more) regional stacks fronted by global DNS / global load balancer, with cross-region replication for the state layer.
- **Components:** Global DNS or Global LB (amber, top center) · Region A block (grouped: Frontend · Backend · DB) · Region B block (grouped: Frontend · Backend · DB) · Cross-region replication arrow between the two databases.
- **Layout hint:** Global LB at the top. Region A on the left, Region B on the right, each as a visually grouped cluster (same-color border rectangle around the region's components). Replication arrow runs horizontally between the DBs at the bottom, labeled "async replication" or "sync replication".
- **Arrows:** Global LB → each region's Frontend (two downward arrows). Within each region: standard 3-tier flow. Cross-region: DB-A ↔ DB-B.
- **Use when:** user mentions active-active, active-passive, DR, failover, or "multi-region".

### (e) Microservices Mesh

- **Description:** API Gateway fronts several services; services share a database (or each has its own); a dedicated Auth service sits on the side.
- **Components:** API Gateway (cyan, left) · 3–4 Services (emerald, center, vertically stacked) · Shared DB or per-service DBs (violet, right) · Auth Service (rose, above or separated from the mesh).
- **Layout hint:** Gateway on the left. Services stacked vertically in the center column. Database(s) on the right. Auth Service floats above, with a dashed arrow from every service → Auth (token validation).
- **Arrows:** Gateway → each service (fan out). Each service → its DB. Each service → Auth (thin/dashed for cross-cutting concern).
- **Use when:** user describes a services diagram with 3+ services, or mentions "mesh", "gateway", or a dedicated auth concern.

---

### Archetype selection guide

When the user's request does not obviously map to one of the five, pick the closest and note the deviation in the Step 1.5 plan rather than inventing a new archetype. The point of these skeletons is to anchor generation — an imperfect fit on a proven skeleton renders better than a bespoke layout assembled from scratch.

If the diagram genuinely needs > 20 components, **split** the diagram by archetype (e.g. one multi-region diagram + one per-region microservices diagram) instead of cramming everything onto one canvas.

