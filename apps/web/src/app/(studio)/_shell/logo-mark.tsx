/**
 * The Agent Studio mark: the hexagon in a violet `accent-solid` tile (design-system/assets/Logos,
 * drawn as in the prototype). Decorative: the product name is always set beside it.
 */
export function LogoMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md bg-brand-solid text-on-brand"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3l7 4v10l-7 4-7-4V7z M12 8v8 M8.5 10l7 4 M15.5 10l-7 4" />
      </svg>
    </span>
  );
}
