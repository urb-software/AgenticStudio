// The black/white opacity exception is for shadcn primitives in shared/ui, not compositions.
export function Drawer() {
  return <div className="fixed inset-0 bg-black/50" />;
}
