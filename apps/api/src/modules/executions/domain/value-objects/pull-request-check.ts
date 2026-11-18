import type { PullRequestCheckState } from './pull-request-check-state.js';

export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  durationSeconds?: number;
  url: string;
}
