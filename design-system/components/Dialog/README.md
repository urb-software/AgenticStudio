# Dialog

Modal for one decision or one short form: New project, Run task, Approve & merge, Request changes, Publish, and every destructive confirm.

- Title is the question or the action ("Approve & merge to dev?", "Cancel r-1043?"); the description names the object.
- The body lists what will happen. The approve dialog must list the changed files, the test result and the target branch.
- Footer: ghost "Cancel"/"Keep it" on the left of the confirm. Destructive confirms use `destructive` and set `destructive` on the dialog (alertdialog role).
- Esc and a backdrop click close it, except while it's submitting. Focus goes to the first field.
