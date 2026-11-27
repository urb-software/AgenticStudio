/** What a Run has used of its send-backs, and the review it owes a re-run. */
export interface SendBackState {
  /** The send-backs the Run used so far, across every review Phase. */
  used: number;
  /** The position of the review Phase that sent work back and is to run again; none when absent. */
  returnTo?: number | null;
}
