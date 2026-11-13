// Overlay scrims may use black/white with an opacity modifier, in shared/ui only (the design
// system has no overlay token). Tokens take opacity modifiers anywhere.
export function DialogOverlay() {
  return <div className="fixed inset-0 bg-black/55 data-open:bg-black/[.5]" />;
}

export const bannerClass = 'border-run-failed/30 bg-run-failed-soft text-run-failed';
