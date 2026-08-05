/**
 * Legacy compatibility stub.
 * Runtime processing moved from GitHub Actions to the local Windows agent.
 */
export class GitHubDispatchError extends Error {
  constructor(message = "GitHub Actions processing is disabled") {
    super(message);
    this.name = "GitHubDispatchError";
  }
}

export async function dispatchDownloadWorkflow(): Promise<never> {
  throw new GitHubDispatchError();
}
