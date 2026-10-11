# Task graph presentation sources

- Friend baseline: `346b358d20c63a28a55818be0b9557446cfd4bc8`. TaskPanel snapshots, Swarm graph/attempt/teammate identity, Workflow definitions and node state remain authoritative. The canvas never changes scheduling or Pi history.
- Wind reference: `58aed73076c5585e3e1ba1b8e3d75c5ad19186d4`, `apps/desktop/src/renderer/planweave/flowModel.ts:291-350`, `apps/desktop/src/renderer/swarm-canvas-layout.ts:443-453,526-536`, and `apps/desktop/src/renderer/SwarmCanvas.tsx:825-856,1100-1157`. The stable rank/order and anchored viewport geometry were adapted to Friend's read-only cards; PlanWeave models, editing, semantic zoom and `@xyflow/react` were not imported.
- New implementation uses React, SVG, Pointer Events and ResizeObserver already available in Friend. No dependency or lockfile change.

Wind's repository license is MIT (copyright 2025 Mario Zechner), also preserved in Friend's root `LICENSE`:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
