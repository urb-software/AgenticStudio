# StatusPill

The run state, everywhere a run appears: tables, cards, headers, popovers. It's the one place colour carries meaning, so the six states map to fixed tokens and are never reused for anything else.

| status | token | meaning |
|---|---|---|
| `queued` | run-queued | waiting for a worker |
| `running` | run-running | CLI is working (dot pulses) |
| `awaiting` | run-awaiting | needs the operator: the only amber |
| `succeeded` | run-succeeded | merged / passed |
| `failed` | run-failed | stopped on an error |
| `cancelled` | run-cancelled | cancelled, rejected or stopped: outlined, quiet |

`none` is the dashed placeholder for "No runs yet". Pass children to override the label ("Rejected", "Merged", "Preview Healthy") without changing the colour logic. The dot plus the word means colour is never the only signal.
