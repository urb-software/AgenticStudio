# RunTimeline

The fixed run lifecycle: Queued → Preparing worktree → Running CLI → Tests → Awaiting approval → Merged. Done steps get a green check, the current step pulses blue, an approval gate pulses amber, and a failure turns red with an ✕. Don't add custom steps for agent-internal phases; those live in the log sections.
