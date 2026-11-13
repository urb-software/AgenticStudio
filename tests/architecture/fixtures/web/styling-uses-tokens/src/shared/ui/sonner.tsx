import { DialogOverlay } from './dialog';

// CSS variables pointing at tokens are not palette utilities.
export function Toaster() {
  return (
    <div className="bg-transparent text-current [--normal-bg:var(--surface)]!">
      <DialogOverlay />
    </div>
  );
}
