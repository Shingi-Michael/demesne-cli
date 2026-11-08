import type { ShotBounds } from "../../../packages/screen/src/index.ts";

/// Where a screen rectangle falls on the page: the page's CSS pixels.
export function onPage(bounds: ShotBounds, content: ShotBounds, zoom: number): ShotBounds {
  return { x: (bounds.x - content.x) / zoom, y: (bounds.y - content.y) / zoom, width: bounds.width / zoom, height: bounds.height / zoom };
}
