import type { PointerSourceDriver } from '@101/connect';

type Touch = Readonly<{ identifier: unknown; locationX: number; locationY: number; pageX: number; pageY: number }>;
export function applyPointerTouches(
  driver: Pick<PointerSourceDriver, 'begin' | 'move' | 'end'>,
  touches: readonly Touch[], action: 'begin' | 'move' | 'end',
  size: Readonly<{ width: number; height: number }>,
): void {
  for (const touch of touches) {
    const id = typeof touch.identifier === 'number' ? touch.identifier :
      typeof touch.identifier === 'string' && /^\d+$/.test(touch.identifier) ? Number(touch.identifier) : NaN;
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (action === 'end') driver.end(id);
    // Android re-hit-tests for locationX/Y on every move, even while keeping
    // the original gesture target. Root coordinates keep relative deltas stable
    // when the finger crosses a child label or leaves the pad's bounds.
    else driver[action](id, touch.pageX, touch.pageY, size.width, size.height);
  }
}
