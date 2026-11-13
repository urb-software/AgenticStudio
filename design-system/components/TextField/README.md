# TextField

Labelled input. A visible label is mandatory (no placeholder-as-label); the label and help/error text are wired with `htmlFor` and `aria-describedby`.

- Validate on submit, then live while the user fixes it. Errors replace the help text, start with what's wrong, and say how to fix it: "Name is required", "Max 100 characters", "Use an SSH (git@…) or HTTPS URL".
- `mono` for code values: repo URLs, branch names, commands, env var names, allowed tools.
- Secrets use `type="password"`, `autoComplete="off"` and help text saying where they're stored ("Stored outside Git…"). Never prefill or reveal a stored secret.
- `multiline` for task descriptions and review comments.
