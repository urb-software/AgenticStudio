# Button

Buttons start an action. **Primary** (accent-solid) appears at most once per view, for the thing the screen is for: "New project", "Start run", "Approve & merge to dev". Everything else is secondary.

- Variants: `secondary` (default), `primary`, `ghost` (toolbars, Cancel in dialogs), `danger` (outlined: Cancel run, Stop), `destructive` (solid red: only the confirm button inside a destructive dialog).
- Sizes: `md` 36px default, `sm` 30px inside cards and toolbars, `lg` 44px for the login submit.
- Label: verb first, sentence case, the object when it isn't obvious ("Connect repository", not "Submit"). Keep `&` in "Approve & merge".
- `loading` swaps the icon for a spinner, disables the button and changes the label to the present participle ("Creating…", "Merging…").
- Destructive actions always go through a confirm `Dialog`; the trigger is `danger`, the confirm is `destructive`.
- Shortcut hints sit inside the button as a `Kbd` only on the primary action of a page.
